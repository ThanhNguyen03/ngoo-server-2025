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
  config,
  JOI_ID_SCHEMA,
  RATE_LIMIT_CONFIGS,
  rateLimitWrapper,
  RedisHelper,
  schemaPagination,
  sortQuery,
  TPagination,
} from '@helper';
import { NotFoundError, ValidationError } from '@lib';
import { OrderModel, PaymentModel, TOrder, TPayment } from '@model';
import { emitPaymentStatus, getOrCacheUserInfo, logAudit } from '@service';
import Joi from 'joi';
import mongoose from 'mongoose';

/**
 * Minimum order shape required by the user-facing mapper — compatible with
 * both lean (`FlattenMaps<IOrder>`) and hydrated Mongoose results.
 * Using `Omit<TPayment, 'order'>` removes the raw ObjectId ref field to avoid
 * the `ObjectId` vs `FlattenMaps<IOrder>` mismatch when `.lean()` is used.
 */
type TPaymentUserMappable = Omit<TPayment, 'order'> & {
  order: Pick<TOrder, 'paymentMethod' | 'totalPrice' | 'userInfoSnapshot' | 'items' | 'transactionId'>;
};

/**
 * Admin mapper needs all payment-method-specific fields from TPayment
 * (txHash, paypalTransaction, codTransactionId) which are already included
 * in `Omit<TPayment, 'order'>`.
 */
type TPaymentAdminMappable = TPaymentUserMappable;

/**
 * Map a payment + populated order to the user-facing `TUserPaymentResponse`.
 * Used by per-user payment history queries.
 */
const toUserPaymentResponse = (history: TPaymentUserMappable): TUserPaymentResponse => ({
  paymentId: history.paymentId,
  orderId: history.orderId,
  paymentMethod: history.order.paymentMethod,
  totalPrice: history.order.totalPrice,
  status: history.status,
  userInfo: history.order.userInfoSnapshot,
  items: history.order.items,
  transactionId: history.order.transactionId,
  createdAt: history.createdAt.getTime(),
  updatedAt: history.updatedAt.getTime(),
});

/**
 * Map a payment + populated order to the admin-facing `TPaymentResponse`.
 * Includes payment-method-specific fields (txHash, paypalTransaction, codTransactionId).
 */
const toAdminPaymentResponse = (history: TPaymentAdminMappable): TPaymentResponse => ({
  paymentId: history.paymentId,
  orderId: history.orderId,
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
});

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

const PAYMENT_LOCK_TTL = config.LOCK_PAYMENT_TTL_MS;
export const resolverPayment: Resolvers = {
  Query: {
    paymentUserHistory: authorizedWrapper(JOI_PAYMENT_ID, async (_root, _args, context) => {
      const { userId } = context.user;
      await getOrCacheUserInfo(userId);

      const { paymentId } = _args;
      const paymentHistory = await PaymentModel.findOne({ paymentId, userId }).populate<{
        order: TOrder;
      }>('order');

      if (!paymentHistory || !paymentHistory.order) {
        throw new NotFoundError('Payment not found');
      }

      return toUserPaymentResponse(paymentHistory);
    }),

    listUserPaymentHistory: authorizedWrapper(JOI_LIST_PAYMENT, async (_root, _args, context) => {
      const { userId } = context.user;
      await getOrCacheUserInfo(userId);

      const { offset, limit, query } = _args;
      const sort = sortQuery(query);

      // Per-user payment history cache (60s TTL, version-based invalidation)
      const cacheKey = `user:${userId}:${offset}:${limit}:${JSON.stringify(sort)}`;
      const cached = await RedisHelper.payment.paymentListGet(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const [listPaymentHistory, total] = await Promise.all([
        PaymentModel.find({ userId }).populate<{ order: TOrder }>('order').skip(offset).limit(limit).sort(sort).lean(),
        PaymentModel.countDocuments({ userId }),
      ]);

      const records: TUserPaymentResponse[] = listPaymentHistory.map(toUserPaymentResponse);

      const result = {
        offset,
        limit,
        query,
        total,
        records,
      };

      await RedisHelper.payment.paymentListSet(cacheKey, JSON.stringify(result));

      return result;
    }),

    listPaymentHistory: adminWrapper(JOI_LIST_PAYMENT, async (_root, _args) => {
      const { offset, limit, query } = _args;
      const sort = sortQuery(query);

      // Admin payment history cache (60s TTL, version-based invalidation)
      const cacheKey = `admin:${offset}:${limit}:${JSON.stringify(sort)}`;
      const cached = await RedisHelper.payment.paymentListGet(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const [listPaymentHistory, total] = await Promise.all([
        PaymentModel.find().populate<{ order: TOrder }>('order').skip(offset).limit(limit).sort(sort).lean(),
        PaymentModel.countDocuments(),
      ]);

      const records: TPaymentResponse[] = listPaymentHistory.map(toAdminPaymentResponse);

      const result = {
        offset,
        limit,
        query,
        total,
        records,
      };

      await RedisHelper.payment.paymentListSet(cacheKey, JSON.stringify(result));

      return result;
    }),
  },

  Mutation: {
    approveCODPayment: adminWrapper(
      JOI_APPROVE_COD_PAYMENT,
      rateLimitWrapper(RATE_LIMIT_CONFIGS.ADMIN_MUTATION, async (_root, { paymentInput }) => {
        const { orderId } = paymentInput;

        if (!orderId) {
          throw new ValidationError('Invalid order ID');
        }

        return await RedisHelper.lock.withLock(orderId, PAYMENT_LOCK_TTL, async () => {
          const order = await OrderModel.findOne({ orderId });
          if (!order) {
            throw new NotFoundError('Order not found');
          }

          // existed payment by transaction hash
          const payment = await PaymentModel.findOne({
            order: order._id,
            status: { $in: [EPaymentStatus.Processing, EPaymentStatus.Success] },
            $or: [{ codTransactionId: order.transactionId }],
          });

          if (!payment) {
            throw new NotFoundError('COD payment record not found');
          }

          if (payment.status === EPaymentStatus.Processing) {
            // Wrap both saves in a transaction so Order and Payment are always
            // updated atomically. The outer Redis lock prevents concurrent calls,
            // but the transaction adds DB-level atomicity as a safety net.
            const session = await mongoose.startSession();
            try {
              await session.withTransaction(async () => {
                order.orderStatus = EOrderStatus.Paid;
                await order.save({ session });

                payment.status = EPaymentStatus.Success;
                await payment.save({ session });
              });
            } finally {
              session.endSession();
            }

            emitPaymentStatus(payment.userId, {
              orderId,
              paymentId: payment.paymentId,
              status: payment.status,
            });

            // Invalidate payment + order list caches after status change
            await Promise.all([
              RedisHelper.payment.paymentListInvalidate(),
              RedisHelper.order.orderListInvalidate(),
            ]);

            // Fire-and-forget audit log for COD payment approval
            logAudit({
              userId: payment.userId,
              action: 'UPDATE',
              targetType: 'Payment',
              targetId: payment.paymentId,
              metadata: { event: 'approveCODPayment', orderId, status: EPaymentStatus.Success },
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
    ),
  },
};
