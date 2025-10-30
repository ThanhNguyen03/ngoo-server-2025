import { TTableName } from './../../../helper/config';
import {
  EOrderStatus,
  EPaymentMethod,
  MutationCreateOrderArgs,
  OrderItemInput,
  QueryGetOrderArgs,
  Resolvers,
} from '@/generated/graphql';
import { authorizedWrapper, JOI_ID_SCHEMA } from '@/helper';
import Joi from 'joi';
import { JOI_ITEM_OPTION } from '../item';
import { OrderModel, TOrder, TUserInfo, UserModel } from '@/model';
import { randomUUID } from 'crypto';

const JOI_ORDER_ID = Joi.object<QueryGetOrderArgs>({
  orderId: JOI_ID_SCHEMA,
});
const JOI_CREATE_ORDER = Joi.object<MutationCreateOrderArgs>({
  input: Joi.object({
    userId: JOI_ID_SCHEMA,
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
  }),
});

export const resolverOrder: Resolvers = {
  Query: {
    getOrder: authorizedWrapper(JOI_ORDER_ID, async (_root, _args) => {
      const { orderId } = _args;
      const order = await OrderModel.findOne({ orderId });
      if (!order) {
        throw new Error('Order isnot existed!');
      }

      return {
        orderId,
        userInfoSnapshot: order.userInfoSnapshot,
        items: order.items,
        totalPrice: order.totalPrice,
        paymentMethod: order.paymentMethod,
        orderStatus: order.orderStatus,
        createdAt: order.createdAt.getTime(),
        updatedAt: order.updatedAt.getTime(),
      };
    }),
  },

  Mutation: {
    createOrder: authorizedWrapper(JOI_CREATE_ORDER, async (_root, { input }) => {
      // TODO: get from redis
      const user = await UserModel.findOne({ uuid: input.userId }).populate<{ userInfo: TUserInfo }>('userInfo').exec();
      if (!user) {
        throw new Error('Authorization Error!');
      }
      const userInfoSnapshot = {
        name: user.userInfo.name,
        address: user.userInfo.address,
        phoneNumber: user.userInfo.phoneNumber,
        email: user.email,
      };

      // TODO: handle re-calculate total price
      const totalPrice = 1;

      const newOrder = await OrderModel.create({
        userInfoSnapshot,
        items: input.items,
        totalPrice,
        orderStatus: EOrderStatus.Pending,
        paymentMethod: input.paymentMethod,
      });

      if (input.paymentMethod === EPaymentMethod.Momo) {
        // TODO
      }
      if (input.paymentMethod === EPaymentMethod.Crypto) {
        // TODO
      }

      return {
        orderId: newOrder.orderId,
        codPaymentData: randomUUID(),
        createdAt: newOrder.createdAt.getTime(),
        updatedAt: newOrder.createdAt.getTime(),
      };
    }),
  },
};
