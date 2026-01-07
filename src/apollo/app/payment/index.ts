import {
  EOrderStatus,
  EPaymentStatus,
  MutationApproveCodPaymentArgs,
  QueryPaymentUserHistoryArgs,
  Resolvers,
  TPaymentResponse,
  TUserPaymentResponse,
} from '@generated/graphql';
import {
  adminWrapper,
  authorizedWrapper,
  JOI_ID_SCHEMA,
  RedisHelper,
  schemaPagination,
  sortQuery,
  TPagination,
} from '@helper';
import { OrderModel, PaymentModel, TOrder, TUserInfo, UserModel } from '@model';
import { io } from '@service';
import Joi from 'joi';

enum EPaymentQuery {
  Status = 'status',
  CreatedAt = 'createdAt',
  TotalPrice = 'totalPrice',
}

const JOI_PAYMENT_ID = Joi.object<QueryPaymentUserHistoryArgs>({
  paymentId: JOI_ID_SCHEMA,
});

const JOI_LIST_PAYMENT = Joi.object<Omit<TPagination, 'total'>>({
  ...schemaPagination(Object.values(EPaymentQuery)),
});

const JOI_APPROVE_COD_PAYMENT = Joi.object<MutationApproveCodPaymentArgs>({
  paymentInput: Joi.object({
    orderId: JOI_ID_SCHEMA,
  }),
});

const PAYMENT_LOCK_TTL = 10_000;
export const resolverPayment: Resolvers = {
  Query: {
    paymentUserHistory: authorizedWrapper(JOI_PAYMENT_ID, async (_root, _args, context) => {
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

      const { paymentId } = _args;
      const paymentHistory = await PaymentModel.findOne({ paymentId, userId }).populate<{
        order: TOrder;
      }>('order');

      if (!paymentHistory || !paymentHistory.order) {
        throw new Error('Payment not exist!');
      }

      return {
        paymentId,
        orderId: paymentHistory.order.orderId,
        paymentMethod: paymentHistory.order.paymentMethod,
        totalPrice: paymentHistory.order.totalPrice,
        status: paymentHistory.status,
        userInfo: paymentHistory.order.userInfoSnapshot,
        items: paymentHistory.order.items,
        transactionId: paymentHistory.order.transactionId,
        createdAt: paymentHistory.createdAt.getTime(),
        updatedAt: paymentHistory.updatedAt.getTime(),
      };
    }),

    listUserPaymentHistory: authorizedWrapper(JOI_LIST_PAYMENT, async (_root, _args, context) => {
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

      const { offset, limit, query } = _args;
      const sort = sortQuery(query);

      const [listPaymentHistory, total] = await Promise.all([
        PaymentModel.find({ userId }).populate<{ order: TOrder }>('order').skip(offset).limit(limit).sort(sort).lean(),
        PaymentModel.countDocuments({ userId }),
      ]);

      const records: TUserPaymentResponse[] = listPaymentHistory.map((history) => {
        return {
          paymentId: history.paymentId,
          orderId: history.order.orderId,
          paymentMethod: history.order.paymentMethod,
          totalPrice: history.order.totalPrice,
          status: history.status,
          userInfo: history.order.userInfoSnapshot,
          items: history.order.items,
          transactionId: history.order.transactionId,
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

    listPaymentHistory: adminWrapper(JOI_LIST_PAYMENT, async (_root, _args) => {
      const { offset, limit, query } = _args;
      const sort = sortQuery(query);

      const [listPaymentHistory, total] = await Promise.all([
        PaymentModel.find().populate<{ order: TOrder }>('order').skip(offset).limit(limit).sort(sort).lean(),
        PaymentModel.countDocuments(),
      ]);

      const records: TPaymentResponse[] = listPaymentHistory.map((history) => {
        return {
          paymentId: history.paymentId,
          orderId: history.order.orderId,
          paymentMethod: history.order.paymentMethod,
          totalPrice: history.order.totalPrice,
          status: history.status,
          userInfo: history.order.userInfoSnapshot,
          items: history.order.items,
          txHash: history.txHash,
          paypalTransaction: history.paypalTransaction,
          codTransactionId: history.codTransactionId,
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
    approveCODPayment: adminWrapper(JOI_APPROVE_COD_PAYMENT, async (_root, { paymentInput }) => {
      const { orderId } = paymentInput;

      if (!orderId) {
        throw new Error('Invalid order ID!');
      }

      return await RedisHelper.lock.withLock(orderId, PAYMENT_LOCK_TTL, async () => {
        const order = await OrderModel.findOne({ orderId });
        if (!order) {
          throw new Error('Not exist order!');
        }

        // existed payment by transaction hash
        const payment = await PaymentModel.findOne({
          order: order._id,
          status: { $in: [EPaymentStatus.Processing, EPaymentStatus.Success] },
          $or: [{ codTransactionId: order.transactionId }],
        });

        if (!payment) {
          throw new Error('Invalid COD payment');
        }

        if (payment.status === EPaymentStatus.Processing) {
          // update order
          order.orderStatus = EOrderStatus.Paid;
          await order.save();

          payment.status = EPaymentStatus.Success;
          await payment.save();

          io.to(payment.userId).emit('paymentStatus', {
            orderId,
            paymentId: payment.paymentId,
            status: payment.status,
          });
        }

        return {
          paymentId: payment.paymentId,
          orderId: order.orderId,
          paymentMethod: order.paymentMethod,
          totalPrice: order.totalPrice,
          status: payment.status,
          userInfo: order.userInfoSnapshot,
          items: order.items,
          transactionId: order.transactionId,
          createdAt: payment.createdAt.getTime(),
          updatedAt: payment.updatedAt.getTime(),
        };
      });
    }),
  },
};
