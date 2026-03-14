import {
  EOrderStatus,
  EPaymentMethod,
  EPaymentStatus,
  MutationCreateOrderArgs,
  OrderItemInput,
  QueryGetUserOrderArgs,
  Resolvers,
  TOrderItem,
  TOrderResponse,
  TUserInfoSnapshot,
  UserInfoSnapshotInput,
} from '@generated/graphql';
import {
  adminWrapper,
  authorizedWrapper,
  calculateOrderItemPrice,
  config,
  JOI_ID_SCHEMA,
  RedisHelper,
  schemaPagination,
  sortQuery,
  TPagination,
} from '@helper';
import { createLogger, NotFoundError, PaymentError, RateLimitError, ValidationError } from '@lib';
import { EBehaviorEvent, ItemModel, OrderModel, PaymentModel, TOrder, UserBehaviorModel } from '@model';
import { cryptoPaymentService, getOrCacheUserInfo, paypalService, type ICryptoPaymentProof } from '@service';
import { randomUUID } from 'crypto';
import Joi from 'joi';
import mongoose from 'mongoose';
import { RATE_LIMIT_CONFIGS, rateLimitWrapper } from 'src/helper/rate-limit';
import { JOI_ITEM_OPTION } from '../item';

/**
 * Map a Mongoose order document to the GraphQL `TOrderResponse` type.
 * Centralises the mapping to avoid repeating field assignments across
 * every query resolver. `createdAt`/`updatedAt` are converted from
 * `Date` to Unix milliseconds to match the GraphQL `Int` scalar.
 *
 * @param order - Lean or hydrated order document.
 */
const logger = createLogger('OrderResolver');

const toOrderResponse = (order: TOrder): TOrderResponse => ({
  orderId: order.orderId,
  transactionId: order.transactionId,
  userInfoSnapshot: order.userInfoSnapshot,
  items: order.items,
  totalPrice: order.totalPrice,
  paymentMethod: order.paymentMethod,
  orderStatus: order.orderStatus,
  createdAt: order.createdAt.getTime(),
  updatedAt: order.updatedAt.getTime(),
});

enum EOrderQuery {
  CreatedAt = 'createdAt',
}
const JOI_ORDER_ID = Joi.object<QueryGetUserOrderArgs>({
  orderId: JOI_ID_SCHEMA,
});
const JOI_LIST_ORDER = Joi.object<Omit<TPagination, 'total'>>({
  ...schemaPagination(Object.values(EOrderQuery)),
});
const JOI_CREATE_ORDER = Joi.object<MutationCreateOrderArgs>({
  input: Joi.object({
    items: Joi.array<OrderItemInput>()
      .items(
        Joi.object({
          itemId: JOI_ID_SCHEMA,
          amount: Joi.number().min(1).required(),
          note: Joi.string().max(200),
          selectedOptions: Joi.array().items(JOI_ITEM_OPTION).default([]),
        }),
      )
      .required(),
    userInfo: Joi.object<UserInfoSnapshotInput>({
      name: Joi.string().max(25).min(8).required(),
      address: Joi.string().min(8).required(),
      phoneNumber: Joi.string()
        .min(8)
        .max(15)
        .regex(/^[0-9]{8,15}$/)
        .required(),
      email: Joi.string().email().required(),
    }).required(),
    paymentMethod: Joi.string()
      .valid(...Object.values(EPaymentMethod))
      .required(),
    returnUrl: Joi.string().uri().required(),
    cancelUrl: Joi.string().uri().required(),
  }),
});

export const resolverOrder: Resolvers = {
  Query: {
    getUserOrder: authorizedWrapper(JOI_ORDER_ID, async (_root, _args, context) => {
      const { userId } = context.user;
      const userInfo = await getOrCacheUserInfo(userId);

      const { orderId } = _args;
      // Prefer the stable `userId` field; fall back to `userInfoSnapshot.email`
      // for orders created before the `userId` field was added to the schema.
      const order = await OrderModel.findOne({
        orderId,
        $or: [{ userId }, { 'userInfoSnapshot.email': userInfo.email }],
      });
      if (!order) {
        throw new NotFoundError('Order not found');
      }

      return toOrderResponse(order);
    }),

    getAllOrder: adminWrapper(JOI_LIST_ORDER, async (_root, _args) => {
      const { offset, limit, query } = _args;
      const sort = sortQuery(query);

      // Short-TTL cache (30s) for admin order list — avoids hitting MongoDB on every page refresh.
      const cacheKey = `${offset}:${limit}:${JSON.stringify(sort)}`;
      const cached = await RedisHelper.order.orderListGet(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const [listOrder, total] = await Promise.all([
        OrderModel.find().skip(offset).limit(limit).sort(sort).lean(),
        OrderModel.countDocuments(),
      ]);

      const records: TOrderResponse[] = listOrder.map(toOrderResponse);

      const result = {
        offset,
        limit,
        query,
        total,
        records,
      };

      // Cache the result (best-effort, do not block response)
      await RedisHelper.order.orderListSet(cacheKey, JSON.stringify(result));

      return result;
    }),
  },

  Mutation: {
    createOrder: authorizedWrapper(
      JOI_CREATE_ORDER,
      rateLimitWrapper(RATE_LIMIT_CONFIGS.ORDER_CREATION, async (_root, { input }, context) => {
        const { userId } = context.user;

        //  check processing order
        const processingOrder = await RedisHelper.order.limitProcessingGet(userId);

        if (processingOrder) {
          if (processingOrder.cacheTime > new Date(Date.now() - 2 * 60 * 1000)) {
            throw new PaymentError('Previous payment not complete yet');
          }

          if (processingOrder.paymentMethod === EPaymentMethod.Paypal) {
            await RedisHelper.order.orderDel(processingOrder.orderId);
            await RedisHelper.order.limitProcessingDel(userId);
          }
        }

        if (input.paymentMethod === EPaymentMethod.Cod) {
          const orderAttempts = await RedisHelper.order.limitAttemptGet(userId);
          if (orderAttempts >= 5) {
            throw new RateLimitError('Maximum COD order limit reached');
          }
          await RedisHelper.order.limitAttemptIncrement(userId);
        }

        const userInfoSnapshot: TUserInfoSnapshot = {
          name: input.userInfo.name,
          address: input.userInfo.address,
          phoneNumber: input.userInfo.phoneNumber,
          email: input.userInfo.email,
        };

        const itemIds = input.items.map((o) => o.itemId);
        const dbItems = await ItemModel.find({ itemId: { $in: itemIds } }).lean();

        if (dbItems.length !== input.items.length) {
          throw new NotFoundError('One or more items in the cart were not found');
        }

        const totalPrice = await calculateOrderItemPrice(input.items, dbItems);
        const orderId = randomUUID();

        const orderItems: TOrderItem[] = input.items.map((i) => {
          const itemInfo = dbItems.find((d) => d.itemId === i.itemId)!;
          const basePrice = itemInfo.discountPercent
            ? itemInfo.price - (itemInfo.price * itemInfo.discountPercent) / 100
            : itemInfo.price;

          return {
            item: itemInfo._id,
            image: itemInfo.image,
            name: itemInfo.name,
            note: i.note,
            amount: i.amount,
            price: basePrice,
            discountPercent: itemInfo.discountPercent,
            selectedOptions: i.selectedOptions || [],
          };
        });

        let paypalApproveUrl: string | undefined;
        let transactionId: string | undefined;
        let cryptoPaymentProof: ICryptoPaymentProof | undefined;

        // Paypal
        if (input.paymentMethod === EPaymentMethod.Paypal) {
          await RedisHelper.order.limitProcessingSet(userId, {
            orderId,
            paymentMethod: EPaymentMethod.Paypal,
            cacheTime: new Date(),
          });

          const { approvalUrl } = await paypalService.createPaypalOrder({
            userInfo: userInfoSnapshot,
            totalPrice: totalPrice,
            orders: input.items,
            orderId,
            listItemInfo: dbItems,
            returnUrl: input.returnUrl,
            cancelUrl: input.cancelUrl,
          });
          if (!approvalUrl) {
            await RedisHelper.order.limitProcessingDel(userId);
            throw new PaymentError('Failed to get PayPal approval URL');
          }

          await RedisHelper.order.orderSet(orderId, {
            userId,
            userInfoSnapshot,
            items: orderItems,
            totalPrice,
          });
          paypalApproveUrl = approvalUrl;
        }

        if (input.paymentMethod === EPaymentMethod.Cod) {
          // Generate the payment ID upfront so it can be used as the order's
          // transactionId before the Payment document is created. This avoids
          // the bug where transactionId was `undefined` at order-creation time.
          const paymentId = randomUUID();
          transactionId = paymentId;

          await RedisHelper.order.limitProcessingSet(userId, {
            orderId,
            paymentMethod: EPaymentMethod.Cod,
            cacheTime: new Date(),
          });

          const session = await mongoose.startSession();
          try {
            await session.withTransaction(async () => {
              const [newOrder] = await OrderModel.create(
                [
                  {
                    orderId,
                    userId,
                    transactionId,
                    userInfoSnapshot,
                    items: orderItems,
                    totalPrice,
                    orderStatus: EOrderStatus.Created,
                    paymentMethod: input.paymentMethod,
                  },
                ],
                { session },
              );

              await PaymentModel.create(
                [
                  {
                    paymentId,
                    order: newOrder._id,
                    orderId,
                    userId,
                    status: EPaymentStatus.Processing,
                  },
                ],
                { session },
              );
            });
            // `withTransaction` auto-aborts on failure — no manual abortTransaction needed.
          } catch (err) {
            await RedisHelper.order.limitProcessingDel(userId);
            throw err;
          } finally {
            session.endSession();
          }
        }

        if (input.paymentMethod === EPaymentMethod.Crypto) {
          // Feature flag check
          if (!config.CRYPTO_PAYMENT_ENABLED) {
            throw new ValidationError('Crypto payment is not available');
          }

          // Verify user has a connected wallet
          const userInfo = await getOrCacheUserInfo(userId);
          if (!userInfo.walletAddress) {
            throw new ValidationError('Please connect your crypto wallet first');
          }

          const paymentId = randomUUID();
          transactionId = paymentId;

          await RedisHelper.order.limitProcessingSet(userId, {
            orderId,
            paymentMethod: EPaymentMethod.Crypto,
            cacheTime: new Date(),
          });

          try {
            // Create order + payment in a transaction
            const session = await mongoose.startSession();
            try {
              await session.withTransaction(async () => {
                const [newOrder] = await OrderModel.create(
                  [
                    {
                      orderId,
                      userId,
                      transactionId,
                      userInfoSnapshot,
                      items: orderItems,
                      totalPrice,
                      orderStatus: EOrderStatus.Created,
                      paymentMethod: input.paymentMethod,
                    },
                  ],
                  { session },
                );

                const proofExpiryMs = config.CRYPTO_PROOF_TTL_SEC * 1000;
                await PaymentModel.create(
                  [
                    {
                      paymentId,
                      order: newOrder._id,
                      orderId,
                      userId,
                      status: EPaymentStatus.Processing,
                      expiredAt: new Date(Date.now() + proofExpiryMs),
                    },
                  ],
                  { session },
                );
              });
            } finally {
              session.endSession();
            }

            // Generate the on-chain payment proof
            cryptoPaymentProof = await cryptoPaymentService.generatePaymentProof({
              orderId,
              totalPriceUsd: totalPrice,
              payerAddress: userInfo.walletAddress,
            });
          } catch (err) {
            // Proof generation failed (price oracle down, Redis unavailable, etc.).
            // The Order + Payment records were already committed to the DB, so we
            // must roll them back to FAILED status — otherwise the user is blocked
            // by limitProcessingSet until it expires (2 min) and cannot retry.
            try {
              await OrderModel.updateOne({ orderId }, { orderStatus: EOrderStatus.Failed });
              await PaymentModel.updateOne({ orderId }, { status: EPaymentStatus.Failed });
            } catch (rollbackErr) {
              logger.error({ err: rollbackErr, orderId }, 'Failed to rollback crypto order/payment to FAILED');
            }
            await RedisHelper.order.limitProcessingDel(userId);
            throw err;
          }
        }

        // Invalidate admin order list cache after successful creation
        await RedisHelper.order.orderListInvalidate();

        // Fire-and-forget: track PURCHASE events for the recommendation engine.
        // Runs after the order is committed — never blocks the response.
        // Uses a separate populate query to get categoryName without touching the main flow.
        ItemModel.find({ itemId: { $in: itemIds } })
          .populate<{ category: { name: string } }>('category', 'name')
          .lean()
          .then((populatedItems) => {
            const behaviors = populatedItems
              .filter((p) => (p as unknown as { category?: { name: string } }).category?.name)
              .map((p) => ({
                userId,
                itemId: p.itemId,
                categoryName: (p as unknown as { category: { name: string } }).category.name,
                event: EBehaviorEvent.PURCHASE,
              }));
            return Promise.all([
              UserBehaviorModel.insertMany(behaviors),
              // Invalidate the user's recommendation cache so next visit reflects the purchase
              RedisHelper.recommendation.userRecsDel(userId),
            ]);
          })
          .catch(() => undefined);

        return {
          orderId,
          paypalApproveUrl: input.paymentMethod === EPaymentMethod.Paypal ? paypalApproveUrl : undefined,
          transactionId:
            input.paymentMethod === EPaymentMethod.Cod || input.paymentMethod === EPaymentMethod.Crypto
              ? transactionId
              : undefined,
          cryptoPaymentProof: input.paymentMethod === EPaymentMethod.Crypto ? cryptoPaymentProof : undefined,
          createdAt: new Date().getTime(),
          updatedAt: new Date().getTime(),
        };
      }),
    ),
  },
};
