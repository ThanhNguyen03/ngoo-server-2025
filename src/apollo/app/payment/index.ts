import {
  EOrderStatus,
  EPaymentMethod,
  EPaymentStatus,
  MutationConfirmPaymentArgs,
  QueryPaymentUserHistoryArgs,
  Resolvers,
  TPaymentResponse,
  TUserPaymentResponse,
} from '@generated/graphql';
import {
  adminWrapper,
  authorizedWrapper,
  capturePaypalOrder,
  JOI_ID_SCHEMA,
  RedisHelper,
  schemaPagination,
  sortQuery,
  TPagination,
} from '@helper';
import { OrderModel, PaymentModel, TOrder, TUserInfo, UserModel } from '@model';
import Joi from 'joi';
import mongoose from 'mongoose';

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

const JOI_CONFIRM_PAYMENT = Joi.object<MutationConfirmPaymentArgs>({
  paymentInput: Joi.object({
    orderId: JOI_ID_SCHEMA,
    transactionId: Joi.string().required(),
  }),
});

const ORDER_CREATE_LOCK_TTL = 5_000;
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
          role: user.role,
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
          role: user.role,
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
    confirmPayment: authorizedWrapper(JOI_CONFIRM_PAYMENT, async (_root, { paymentInput }, context) => {
      const { orderId, transactionId } = paymentInput;
      const { userId } = context.user;

      if (!transactionId) {
        throw new Error('Invalid transaction ID!');
      }
      if (!orderId) {
        throw new Error('Invalid order ID!');
      }

      return await RedisHelper.lock.withLock(orderId, PAYMENT_LOCK_TTL, async () => {
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

        const order = await OrderModel.findOne({ orderId, 'userInfoSnapshot.email': userInfo.email, transactionId });
        if (!order) {
          throw new Error('Not exist order!');
        }

        // existed payment by transaction hash
        const existedPaymentByTxH = await PaymentModel.findOne({
          order: order._id,
          userId,
          $or: [
            { 'paypalTransaction.paypalCaptureId': transactionId },
            { codTransactionId: transactionId },
            { txHash: transactionId },
          ],
        }).populate<{ order: TOrder }>('order');

        if (existedPaymentByTxH) {
          return {
            paymentId: existedPaymentByTxH.paymentId,
            orderId: existedPaymentByTxH.order.orderId,
            paymentMethod: existedPaymentByTxH.order.paymentMethod,
            totalPrice: existedPaymentByTxH.order.totalPrice,
            status: existedPaymentByTxH.status,
            userInfo: existedPaymentByTxH.order.userInfoSnapshot,
            items: existedPaymentByTxH.order.items,
            transactionId: existedPaymentByTxH.order.transactionId,
            createdAt: existedPaymentByTxH.createdAt.getTime(),
            updatedAt: existedPaymentByTxH.updatedAt.getTime(),
          };
        }

        // existed payment by order
        const existedPaymentByOrder = await PaymentModel.findOne({
          order: order._id,
          userId,
          status: { $in: [EPaymentStatus.Processing, EPaymentStatus.Success] },
        }).populate<{ order: TOrder }>('order');

        if (existedPaymentByOrder) {
          return {
            paymentId: existedPaymentByOrder.paymentId,
            orderId: existedPaymentByOrder.order.orderId,
            paymentMethod: existedPaymentByOrder.order.paymentMethod,
            totalPrice: existedPaymentByOrder.order.totalPrice,
            status: existedPaymentByOrder.status,
            userInfo: existedPaymentByOrder.order.userInfoSnapshot,
            items: existedPaymentByOrder.order.items,
            transactionId: existedPaymentByOrder.order.transactionId,
            createdAt: existedPaymentByOrder.createdAt.getTime(),
            updatedAt: existedPaymentByOrder.updatedAt.getTime(),
          };
        }

        const session = await mongoose.startSession();
        session.startTransaction();
        // Create payment record first (status Pending)
        const [newPayment] = await PaymentModel.create(
          [
            {
              order: order._id,
              status: EPaymentStatus.Processing,
              userId,
            },
          ],
          { session },
        );

        try {
          // Paypal
          if (order.paymentMethod === EPaymentMethod.Paypal) {
            const captureResult = await capturePaypalOrder(transactionId, newPayment);

            // update order
            order.orderStatus = EOrderStatus.Paid;
            await order.save({ session });

            // Update payment
            newPayment.paypalTransaction = {
              paypalCaptureId: captureResult.paypalCaptureId,
              paypalPayerEmail: captureResult.paypalPayerEmail,
              payerId: captureResult.payerId,
              rawResponse: captureResult.result as Record<string, unknown>,
            };
            newPayment.status = EPaymentStatus.Success;
            await newPayment.save({ session });
          }

          // COD
          if (order.paymentMethod === EPaymentMethod.Cod) {
            newPayment.codTransactionId = transactionId;
            await newPayment.save({ session });
          }

          // Crypto
          if (order.paymentMethod === EPaymentMethod.Crypto) {
            // TODO
            throw new Error('Crypto payment not implemented yet');
          }

          await session.commitTransaction();
          session.endSession();
          const populated = await newPayment.populate<{ order: TOrder }>('order');
          return {
            paymentId: populated.paymentId,
            orderId: populated.order.orderId,
            paymentMethod: populated.order.paymentMethod,
            totalPrice: populated.order.totalPrice,
            status: populated.status,
            userInfo: populated.order.userInfoSnapshot,
            items: populated.order.items,
            transactionId,
            createdAt: populated.createdAt.getTime(),
            updatedAt: populated.updatedAt.getTime(),
          };
        } catch (err) {
          await session.abortTransaction();
          session.endSession();
          throw err;
        }
      });
    }),

    approveCODPayment: adminWrapper(JOI_CONFIRM_PAYMENT, async (_root, { paymentInput }) => {
      const { orderId, transactionId } = paymentInput;

      if (!transactionId) {
        throw new Error('Invalid transaction ID!');
      }
      if (!orderId) {
        throw new Error('Invalid order ID!');
      }

      return await RedisHelper.lock.withLock(orderId, PAYMENT_LOCK_TTL, async () => {
        const order = await OrderModel.findOne({ orderId, transactionId });
        if (!order) {
          throw new Error('Not exist order!');
        }

        // existed payment by transaction hash
        const existedPayment = await PaymentModel.findOne({
          order: order._id,
          status: { $in: [EPaymentStatus.Processing, EPaymentStatus.Success] },
          $or: [{ codTransactionId: transactionId }],
        }).populate<{ order: TOrder }>('order');

        if (!existedPayment) {
          throw new Error('Invalid COD payment');
        }

        if (existedPayment.status === EPaymentStatus.Processing) {
          // update order
          order.orderStatus = EOrderStatus.Paid;
          await order.save();

          existedPayment.status = EPaymentStatus.Success;
          await existedPayment.save();
        }

        return {
          paymentId: existedPayment.paymentId,
          orderId: existedPayment.order.orderId,
          paymentMethod: existedPayment.order.paymentMethod,
          totalPrice: existedPayment.order.totalPrice,
          status: existedPayment.status,
          userInfo: existedPayment.order.userInfoSnapshot,
          items: existedPayment.order.items,
          transactionId: existedPayment.order.transactionId,
          createdAt: existedPayment.createdAt.getTime(),
          updatedAt: existedPayment.updatedAt.getTime(),
        };
      });
    }),
  },
};
