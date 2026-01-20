import { EPaymentStatus } from '@generated/graphql';
import { randomUUID } from 'crypto';
import { model, Schema, Types } from 'mongoose';

type TPaypalPayment = {
  paypalPayerEmail: string;
  paypalCaptureId: string;
  payerId: string;
  rawResponse?: Record<string, unknown>;
};

const PaypalPaymentShema = new Schema<TPaypalPayment>(
  {
    paypalPayerEmail: { type: String, required: true },
    paypalCaptureId: { type: String, sparse: true, unique: true },
    payerId: { type: String, required: true },
    rawResponse: { type: Schema.Types.Mixed },
  },
  { _id: false }, // donot create id for child options
);

interface IPayment {
  paymentId: string;
  order: Types.ObjectId; // ref Order
  userId: string;
  status: EPaymentStatus;
  txHash?: string; // blockchain Payment hash (for crypto)
  paypalTransaction?: TPaypalPayment; // for Paypal
  codTransactionId?: string; // for COD
  createdAt: Date;
  updatedAt: Date;
}

export type TPayment = IPayment;

const PaymentSchema = new Schema<TPayment>(
  {
    paymentId: { type: String, required: true, unique: true, default: () => randomUUID() },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    userId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED'],
      default: EPaymentStatus.Processing,
    },
    txHash: { type: String, trim: true },
    paypalTransaction: { type: PaypalPaymentShema },
    codTransactionId: { type: String, trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

PaymentSchema.index({ order: 1 });
PaymentSchema.index({ createdAt: -1 });
PaymentSchema.index({ status: 1, createdAt: -1 });
PaymentSchema.index({ userId: 1, createdAt: -1 });
PaymentSchema.index({ userId: 1, status: 1, createdAt: -1 });

PaymentSchema.index({ codTransactionId: 1 }, { unique: true, sparse: true });
PaymentSchema.index({ txHash: 1 }, { unique: true, sparse: true });
PaymentSchema.index({ order: 1, userId: 1 }, { unique: true });

export const PaymentModel = model<TPayment>('Payment', PaymentSchema);
