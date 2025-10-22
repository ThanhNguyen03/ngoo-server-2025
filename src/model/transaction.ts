import mongoose, { Schema, model, Document, Types } from 'mongoose';

export type TPaymentMethod = 'momo' | 'cod' | 'crypto';
export type TPaymentStatus = 'pending' | 'success' | 'failed';

interface ITransaction extends Document {
  user: Types.ObjectId; // ref User
  order: Types.ObjectId; // ref Order
  paymentMethod: TPaymentMethod;
  amount: number;
  status: TPaymentStatus;
  txHash?: string; // blockchain transaction hash (for crypto)
  momoTransactionId?: string; // for Momo
  createdAt: Date;
  updatedAt: Date;
}

export type TTransaction = ITransaction;

const TransactionSchema = new Schema<TTransaction>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    paymentMethod: { type: String, enum: ['momo', 'cod', 'crypto'], required: true },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'success', 'failed', 'refunded'],
      default: 'pending',
    },
    txHash: { type: String, trim: true },
    momoTransactionId: { type: String, trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

TransactionSchema.index({ order: 1, user: 1 });
TransactionSchema.index({ createdAt: -1 });
TransactionSchema.index({ txHash: 1 });

export const Transaction = mongoose.models.Transaction || model<TTransaction>('Transaction', TransactionSchema);
