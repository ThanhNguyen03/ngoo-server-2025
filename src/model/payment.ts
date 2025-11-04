import { EPaymentStatus } from '@/generated/graphql';
import { randomUUID } from 'crypto';
import mongoose, { Schema, model, Document, Types } from 'mongoose';

interface IPayment {
  paymentId: string;
  order: Types.ObjectId; // ref Order
  status: EPaymentStatus;
  txHash?: string; // blockchain Payment hash (for crypto)
  paypalTransactionId?: string; // for Paypal
  codTransactionId?: string; // for COD
  createdAt: Date;
  updatedAt: Date;
}

export type TPayment = IPayment;

const PaymentSchema = new Schema<TPayment>(
  {
    paymentId: { type: String, required: true, unique: true, default: () => randomUUID() },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    status: {
      type: String,
      enum: ['PENDING', 'SUCCESSFUL', 'FAILED'],
      default: EPaymentStatus.Pending,
    },
    txHash: { type: String, trim: true },
    paypalTransactionId: { type: String, trim: true },
    codTransactionId: { type: String, trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

PaymentSchema.index({ order: 1, user: 1 });
PaymentSchema.index({ createdAt: -1 });
PaymentSchema.index({ txHash: 1 });

export const PaymentModel = model<TPayment>('Payment', PaymentSchema);
