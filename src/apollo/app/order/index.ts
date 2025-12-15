import {
  EOrderStatus,
  EPaymentMethod,
  MutationCreateOrderArgs,
  OrderItemInput,
  QueryGetUserOrderArgs,
  Resolvers,
  TOrderResponse,
  TUserInfoSnapshot,
} from '@generated/graphql';
import {
  adminWrapper,
  authorizedWrapper,
  calculateOrderItemPrice,
  createPayPalOrderBody,
  JOI_ID_SCHEMA,
  RedisHelper,
  schemaPagination,
  sortQuery,
  TPagination,
} from '@helper';
import { ItemModel, OrderModel, TUserInfo, UserModel } from '@model';
import { randomBytes, randomUUID } from 'crypto';
import Joi from 'joi';
import { ordersController } from 'src/services/paypal';
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
          role: user.role,
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
          role: user.role,
          authMethods: user.authMethods,
          address: user.userInfo.address,
          phoneNumber: user.userInfo.phoneNumber,
        };
        await RedisHelper.account.userInfoSet(userInfo);
      }

      if (!userInfo.address || !userInfo.phoneNumber) {
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

      if (input.paymentMethod === EPaymentMethod.Paypal) {
        try {
          const orderBody = await createPayPalOrderBody({
            totalPrice: totalPrice,
            orders: input.items,
            orderId,
            listItemInfo: dbItems,
          });
          const { result } = await ordersController.createOrder({ body: orderBody });
          if (!result || !result.links || !result.id) {
            throw new Error('Failed to create Paypal order!');
          }

          const approveUrl = result.links.find((l) => l.rel === 'approve')!.href;

          const newOrder = await OrderModel.create({
            orderId,
            transactionId: result.id,
            userInfoSnapshot,
            items: input.items,
            totalPrice,
            orderStatus: EOrderStatus.Created,
            paymentMethod: input.paymentMethod,
          });

          return {
            orderId: newOrder.orderId,
            paypalApproveUrl: approveUrl,
            transactionId: result.id,
            createdAt: newOrder.createdAt.getTime(),
            updatedAt: newOrder.updatedAt.getTime(),
          };
        } catch (err) {
          throw err;
        }
      }

      if (input.paymentMethod === EPaymentMethod.Cod) {
        const newOrder = await OrderModel.create({
          orderId,
          userInfoSnapshot,
          items: input.items,
          totalPrice,
          orderStatus: EOrderStatus.Created,
          paymentMethod: input.paymentMethod,
        });

        return {
          orderId: newOrder.orderId,
          transactionId: randomBytes(32).toString('hex'),
          createdAt: newOrder.createdAt.getTime(),
          updatedAt: newOrder.updatedAt.getTime(),
        };
      }

      if (input.paymentMethod === EPaymentMethod.Crypto) {
        // TODO
        throw new Error('Crypto payment not implemented yet');
      }

      throw new Error('Invalid payment method');
    }),
  },
};
