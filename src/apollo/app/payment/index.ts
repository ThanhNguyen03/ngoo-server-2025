import {
  EOrderStatus,
  EPaymentMethod,
  EPaymentStatus,
  MutationConfirmPaymentArgs,
  QueryPaymentHistoryArgs,
  Resolvers,
  TPaymentResponse,
} from '@/generated/graphql';
import {
  authorizedWrapper,
  capturePaypalOrder,
  JOI_ID_SCHEMA,
  schemaPagination,
  sortQuery,
  TPagination,
} from '@/helper';
import { OrderModel, PaymentModel, TOrder } from '@/model';
import { Order } from '@paypal/paypal-server-sdk';
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
    paypalTransactionId: Joi.string().alphanum(),
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
        paypalTransaction: paymentHistory.paypalTransaction,
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
          paypalTransaction: history.paypalTransaction,
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
      const { orderId, paypalOrderId, txHash, codTransactionId } = paymentInput;

      const order = await OrderModel.findOne({ orderId });
      if (!order) {
        throw new Error('This payment is paying for not exist order!');
      }

      // existed paid order fail
      const existedPayment = await PaymentModel.findOne({
        order: order._id,
        status: EPaymentStatus.Successful,
      }).populate<{ order: TOrder }>('order');

      if (existedPayment) {
        return {
          paymentId: existedPayment.paymentId,
          orderId: existedPayment.order.orderId,
          paymentMethod: existedPayment.order.paymentMethod,
          totalPrice: existedPayment.order.totalPrice,
          status: existedPayment.status,
          userInfo: existedPayment.order.userInfoSnapshot,
          items: existedPayment.order.items,
          txHash: existedPayment.txHash,
          paypalTransaction: existedPayment.paypalTransaction,
          codTransactionId: existedPayment.codTransactionId,
          createdAt: existedPayment.createdAt.getTime(),
          updatedAt: existedPayment.createdAt.getTime(),
        };
      }

      // Paypal
      if (order.paymentMethod === EPaymentMethod.Paypal) {
        if (!paypalOrderId) {
          throw new Error('Paypal Order Id is required for PayPal payment');
        }
        if (order.paypalOrderId !== paypalOrderId) {
          throw new Error('Paypal Order Id mismatch with server record');
        }

        // Create payment record first (status Pending)
        const newPaypalPayment = await PaymentModel.create({
          order: order._id,
          status: EPaymentStatus.Pending,
        });

        let captureResult: { result: Order; paypalCaptureId: string; paypalPayerEmail: string; payerId: string } = {
          result: {},
          paypalCaptureId: '',
          paypalPayerEmail: '',
          payerId: '',
        };

        try {
          captureResult = await capturePaypalOrder(paypalOrderId, newPaypalPayment);

          // update order
          order.orderStatus = EOrderStatus.Completed;
          await order.save();

          const populated = await newPaypalPayment.populate<{ order: TOrder }>('order');
          return {
            paymentId: populated.paymentId,
            orderId: populated.order.orderId,
            paymentMethod: populated.order.paymentMethod,
            totalPrice: populated.order.totalPrice,
            status: populated.status,
            userInfo: populated.order.userInfoSnapshot,
            items: populated.order.items,
            txHash: populated.txHash,
            paypalTransaction: populated.paypalTransaction,
            codTransactionId: populated.codTransactionId,
            createdAt: populated.createdAt.getTime(),
            updatedAt: populated.updatedAt.getTime(),
          };
        } catch (err) {
          newPaypalPayment.status = EPaymentStatus.Failed;
          newPaypalPayment.paypalTransaction = {
            paypalCaptureId: captureResult.paypalCaptureId,
            paypalPayerEmail: captureResult.paypalPayerEmail,
            payerId: captureResult.payerId,
            rawResponse: captureResult.result as Record<string, unknown>,
          };
          await newPaypalPayment.save();
          throw err instanceof Error ? err : new Error('PayPal capture failed');
        }
      }

      // Crypto
      if (order.paymentMethod === EPaymentMethod.Crypto) {
        // TODO
        throw new Error('Crypto payment not implemented yet');
      }

      // COD
      if (order.paymentMethod === EPaymentMethod.Cod) {
        if (!codTransactionId) {
          throw new Error('codTransactionId is required for COD');
        }

        const newPayment = await PaymentModel.create({
          order: order._id,
          codTransactionId,
          status: EPaymentStatus.Successful,
        });

        order.orderStatus = EOrderStatus.Completed;
        await order.save();

        const populated = await newPayment.populate<{ order: TOrder }>('order');
        return {
          paymentId: populated.paymentId,
          orderId: populated.order.orderId,
          paymentMethod: populated.order.paymentMethod,
          totalPrice: populated.order.totalPrice,
          status: populated.status,
          userInfo: populated.order.userInfoSnapshot,
          items: populated.order.items,
          txHash: populated.txHash,
          paypalTransaction: populated.paypalTransaction,
          codTransactionId: populated.codTransactionId,
          createdAt: populated.createdAt.getTime(),
          updatedAt: populated.createdAt.getTime(),
        };
      }

      throw new Error('Unsupported payment method');
    }),
  },
};
