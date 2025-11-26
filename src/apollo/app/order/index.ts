import {
  EOrderStatus,
  EPaymentMethod,
  MutationCreateOrderArgs,
  OrderItemInput,
  QueryGetOrderArgs,
  Resolvers,
  TUserInfoSnapshot,
} from '@generated/graphql';
import { authorizedWrapper, calculateOrderItemPrice, createPayPalOrderBody, JOI_ID_SCHEMA, RedisHelper } from '@helper';
import { ItemModel, OrderModel, TUserInfo, UserModel } from '@model';
import { randomUUID } from 'crypto';
import Joi from 'joi';
import { ordersController } from 'src/services/paypal';
import { JOI_ITEM_OPTION } from '../item';

const JOI_ORDER_ID = Joi.object<QueryGetOrderArgs>({
  orderId: JOI_ID_SCHEMA,
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
    getOrder: authorizedWrapper(JOI_ORDER_ID, async (_root, _args) => {
      const { orderId } = _args;
      const order = await OrderModel.findOne({ orderId });
      if (!order) {
        throw new Error('Order is not existed!');
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
        name: userInfo.name,
        address: userInfo.address,
        phoneNumber: userInfo.phoneNumber,
        email: userInfo.email,
      };

      const itemIds = input.items.map((o) => o.itemId);
      const dbItems = await ItemModel.find({ itemId: { $in: itemIds } }).lean();

      if (dbItems.length !== input.items.length) {
        throw new Error('Some items in cart do not exist in DB');
      }

      const totalPrice = await calculateOrderItemPrice(input.items, dbItems);

      const newOrder = await OrderModel.create({
        userInfoSnapshot,
        items: input.items,
        totalPrice,
        orderStatus: EOrderStatus.Pending,
        paymentMethod: input.paymentMethod,
      });

      if (input.paymentMethod === EPaymentMethod.Paypal) {
        try {
          const orderBody = await createPayPalOrderBody({
            totalPrice: totalPrice,
            orders: input.items,
            orderMongoId: newOrder._id,
            orderId: newOrder.orderId,
            listItemInfo: dbItems,
          });
          const { result } = await ordersController.createOrder({ body: orderBody });

          const approveUrl = result.links?.find((l) => l.rel === 'approve')?.href;
          newOrder.paypalOrderId = result.id || '';
          await newOrder.save();

          return {
            orderId: newOrder.orderId,
            paypalApproveUrl: approveUrl,
            paypalOrderId: result.id,
            createdAt: newOrder.createdAt.getTime(),
            updatedAt: newOrder.updatedAt.getTime(),
          };
        } catch (err) {
          newOrder.orderStatus = EOrderStatus.Cancelled;
          await newOrder.save();
          throw new Error('PayPal order creation failed');
        }
      }

      if (input.paymentMethod === EPaymentMethod.Crypto) {
        // TODO
      }

      return {
        orderId: newOrder.orderId,
        codPaymentData: randomUUID(),
        createdAt: newOrder.createdAt.getTime(),
        updatedAt: newOrder.updatedAt.getTime(),
      };
    }),
  },
};
