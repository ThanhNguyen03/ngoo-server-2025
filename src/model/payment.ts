import mongoose, { Schema, model, Document, Types } from 'mongoose';

export type TPaymentMethod = 'MOMO' | 'COD' | 'CRYPTO';
export type TPaymentStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';

interface IPayment extends Document {
  user: Types.ObjectId; // ref User
  order: Types.ObjectId; // ref Order
  paymentMethod: TPaymentMethod;
  totalPrice: number;
  status: TPaymentStatus;
  txHash?: string; // blockchain Payment hash (for crypto)
  transactionId?: string; // for Momo
  momoSnapshot?: {
    payUrl?: string;
    requestId?: string;
    signature?: string;
  };
  cryptoSnapshot?: {
    toAddress?: string;
    amount?: number;
    tokenSymbol?: string;
    chainId?: number;
    dataToSign?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

export type TPayment = IPayment;

const PaymentSchema = new Schema<TPayment>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    paymentMethod: { type: String, enum: ['MOMO', 'COD', 'CRYPTO'], required: true },
    totalPrice: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['PENDING', 'SUCCESSFUL', 'FAILED'],
      default: 'PENDING',
    },
    txHash: { type: String, trim: true },
    transactionId: { type: String, trim: true },
    momoSnapshot: {
      payUrl: { type: String },
      requestId: { type: String },
      signature: { type: String },
    },
    cryptoSnapshot: {
      toAddress: { type: String },
      amount: { type: Number },
      tokenSymbol: { type: String },
      chainId: { type: Number },
      dataToSign: { type: String },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

PaymentSchema.index({ order: 1, user: 1 });
PaymentSchema.index({ createdAt: -1 });
PaymentSchema.index({ txHash: 1 });

export const Transaction = mongoose.models.Payment || model<TPayment>('Payment', PaymentSchema);
