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
  JOI_ID_SCHEMA,
  RedisHelper,
  schemaPagination,
  sortQuery,
  TPagination,
} from '@helper';
import { ItemModel, OrderModel, PaymentModel, TUserInfo, UserModel } from '@model';
import { PaypalService } from '@service';
import { randomBytes, randomUUID } from 'crypto';
import Joi from 'joi';
import mongoose from 'mongoose';
import { JOI_ITEM_OPTION } from '../item';

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

      let userInfo = await RedisHelper.account.userInfoGet(userId);
      if (!userInfo) {
        const user = await UserModel.findOne({ uuid: userId }).populate<{ userInfo: TUserInfo }>('userInfo').exec();
        if (!user) {
          throw new Error('Authorization Error!');
        }
        userInfo = {
          uuid: user.uuid,
          email: user.email,
          name: user.userInfo.name,
          walletAddress: user.userInfo.walletAddress,
          authMethods: user.authMethods,
          address: user.userInfo.address,
          phoneNumber: user.userInfo.phoneNumber,
        };
        await RedisHelper.account.userInfoSet(userInfo);
      }

      const { orderId } = _args;
      const order = await OrderModel.findOne({
        orderId,
        'userInfoSnapshot.email': userInfo.email,
      });
      if (!order) {
        throw new Error('Order is not existed!');
      }

      return {
        orderId,
        transactionId: order.transactionId,
        userInfoSnapshot: order.userInfoSnapshot,
        items: order.items,
        totalPrice: order.totalPrice,
        paymentMethod: order.paymentMethod,
        orderStatus: order.orderStatus,
        createdAt: order.createdAt.getTime(),
        updatedAt: order.updatedAt.getTime(),
      };
    }),

    getAllOrder: adminWrapper(JOI_LIST_ORDER, async (_root, _args) => {
      const { offset, limit, query } = _args;
      const sort = sortQuery(query);

      const [listOrder, total] = await Promise.all([
        OrderModel.find().skip(offset).limit(limit).sort(sort).lean(),
        OrderModel.countDocuments(),
      ]);

      const records: TOrderResponse[] = listOrder.map((history) => {
        return {
          orderId: history.orderId,
          transactionId: history.transactionId,
          userInfoSnapshot: history.userInfoSnapshot,
          items: history.items,
          totalPrice: history.totalPrice,
          paymentMethod: history.paymentMethod,
          orderStatus: history.orderStatus,
          createdAt: history.createdAt.getTime(),
          updatedAt: history.updatedAt.getTime(),
        };
      });

      return {
        offset,
        limit,
        query,
        total,
        records,
      };
    }),
  },

  Mutation: {
    createOrder: authorizedWrapper(JOI_CREATE_ORDER, async (_root, { input }, context) => {
      const { userId } = context.user;

      const userInfo = await RedisHelper.account.userInfoGet(userId);
      if (!userInfo) {
        const user = await UserModel.findOne({ uuid: userId }).populate<{ userInfo: TUserInfo }>('userInfo').exec();
        if (!user) {
          throw new Error('Authorization Error!');
        }
        const userInfoResponse = {
          uuid: user.uuid,
          email: user.email,
          name: user.userInfo.name,
          walletAddress: user.userInfo.walletAddress,
          authMethods: user.authMethods,
          address: user.userInfo.address,
          phoneNumber: user.userInfo.phoneNumber,
        };
        await RedisHelper.account.userInfoSet(userInfoResponse);
      }

      if (!input.userInfo.address || !input.userInfo.phoneNumber) {
        throw new Error('Anonymous user info data Error!');
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
        throw new Error('Some items in cart do not exist in DB');
      }

      const totalPrice = await calculateOrderItemPrice(input.items, dbItems);
      const orderId = randomUUID();

      const session = await mongoose.startSession();
      session.startTransaction();
      const paypalService = PaypalService.getInstance();
      try {
        let transactionId: string | undefined;
        let paypalApproveUrl: string | undefined;
        // Paypal
        if (input.paymentMethod === EPaymentMethod.Paypal) {
          const {
            result,
            approvalUrl,
            paypalOrderId: paypalId,
          } = await paypalService.createPaypalOrder({
            userInfo: userInfoSnapshot,
            totalPrice: totalPrice,
            orders: input.items,
            orderId,
            listItemInfo: dbItems,
            returnUrl: input.returnUrl,
            cancelUrl: input.cancelUrl,
          });
          if (!approvalUrl) {
            throw new Error('Failed to get PayPal approval URL!');
          }
          paypalApproveUrl = approvalUrl;
        }

        if (input.paymentMethod === EPaymentMethod.Cod) {
          transactionId = randomBytes(32).toString('hex');
        }
        if (input.paymentMethod === EPaymentMethod.Crypto) {
          // TODO
          throw new Error('Crypto payment not implemented yet');
        }

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

        const [newOrder] = await OrderModel.create(
          [
            {
              orderId,
              transactionId: input.paymentMethod === EPaymentMethod.Cod ? transactionId! : undefined,
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
              order: newOrder._id,
              userId,
              status: EPaymentStatus.Processing,
            },
          ],
          { session },
        );

        await session.commitTransaction();
        session.endSession();

        return {
          orderId: newOrder.orderId,
          transactionId: input.paymentMethod === EPaymentMethod.Cod ? transactionId! : undefined,
          paypalApproveUrl,
          createdAt: newOrder.createdAt.getTime(),
          updatedAt: newOrder.updatedAt.getTime(),
        };
      } catch (err) {
        await session.abortTransaction();
        session.endSession();
        throw err;
      }
    }),
  },
};
