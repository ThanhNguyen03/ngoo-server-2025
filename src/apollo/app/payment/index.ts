import {
  EPaymentMethod,
  MutationConfirmPaymentArgs,
  QueryPaymentHistoryArgs,
  Resolvers,
  TPaymentResponse,
} from '@/generated/graphql';
import { authorizedWrapper, JOI_ID_SCHEMA, schemaPagination, sortQuery, TPagination } from '@/helper';
import { OrderModel, PaymentModel, TOrder } from '@/model';
import Joi from 'joi';

enum EPaymentQuery {
  Status = 'status',
  CreatedAt = 'createdAt',
  TotalPrice = 'totalPrice',
}

const JOI_PAYMENT_ID = Joi.object<QueryPaymentHistoryArgs>({
  paymentId: JOI_ID_SCHEMA,
});

const JOI_LIST_PAYMENT = Joi.object<Omit<TPagination, 'total'>>({
  ...schemaPagination(Object.values(EPaymentQuery)),
});

const JOI_CONFIRM_PAYMENT = Joi.object<MutationConfirmPaymentArgs>({
  paymentInput: Joi.object({
    orderId: JOI_ID_SCHEMA,
    paymentMethod: Joi.string()
      .valid(...Object.values(EPaymentMethod))
      .required(),
    momoTransactionId: Joi.string().alphanum(),
    txHash: Joi.string().alphanum(),
    codTransactionId: Joi.string().alphanum(),
  }),
});

export const resolverPayment: Resolvers = {
  Query: {
    paymentHistory: authorizedWrapper(JOI_PAYMENT_ID, async (_root, _args) => {
      const { paymentId } = _args;
      const paymentHistory = await PaymentModel.findOne({ paymentId }).populate<{ order: TOrder }>('order').exec();
      if (!paymentHistory) {
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
        txHash: paymentHistory.txHash,
        momoTransactionId: paymentHistory.momoTransactionId,
        codTransactionId: paymentHistory.codTransactionId,
        createdAt: paymentHistory.createdAt.getTime(),
        updatedAt: paymentHistory.createdAt.getTime(),
      };
    }),

    listPaymentHistory: authorizedWrapper(JOI_LIST_PAYMENT, async (_root, _args) => {
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
          momoTransactionId: history.momoTransactionId,
          codTransactionId: history.codTransactionId,
          createdAt: history.createdAt.getTime(),
          updatedAt: history.createdAt.getTime(),
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
    confirmPayment: authorizedWrapper(JOI_CONFIRM_PAYMENT, async (_root, { paymentInput }) => {
      const { orderId, paymentMethod, momoTransactionId, txHash, codTransactionId } = paymentInput;

      const order = await OrderModel.findOne({ orderId });
      if (!order) {
        throw new Error('This payment is paying for not exist order!');
      }

      switch (paymentMethod) {
        case EPaymentMethod.Cod: {
          if (!codTransactionId) {
            throw new Error('Transaction ID is not compatible with payment method');
          }
        }
        case EPaymentMethod.Crypto: {
          if (!txHash) {
            throw new Error('Transaction ID is not compatible with payment method');
          }
        }
        case EPaymentMethod.Momo: {
          if (!momoTransactionId) {
            throw new Error('Transaction ID is not compatible with payment method');
          }
        }
      }

      // TODO: handle get BE transaction ID to compare with id from FE
      const payment = await PaymentModel.create({ order, txHash, momoTransactionId, codTransactionId });
      const result = await payment.populate<{ order: TOrder }>('order');

      return {
        paymentId: result.paymentId,
        orderId: result.order.orderId,
        paymentMethod: result.order.paymentMethod,
        totalPrice: result.order.totalPrice,
        status: result.status,
        userInfo: result.order.userInfoSnapshot,
        items: result.order.items,
        txHash: result.txHash,
        momoTransactionId: result.momoTransactionId,
        codTransactionId: result.codTransactionId,
        createdAt: result.createdAt.getTime(),
        updatedAt: result.createdAt.getTime(),
      };
    }),
  },
};
