import mongoose, { Schema, model, Document, Types } from 'mongoose';
import { TItemOption } from './item';
import { TPaymentMethod, TPaymentStatus } from './transaction';

export type TOrderStatus = 'pending' | 'completed' | 'cancelled' | 'delivering';
export type TUserInfoSnapshot = {
  name?: string;
  address?: string;
  phoneNumber?: string;
  email: string;
};

interface IOrderItem {
  item: Types.ObjectId; // ref Item
  title: string;
  quantity: number;
  price: number;
  discountPercent?: number;
  selectedOptions?: TItemOption[];
}

interface IOrder extends Document {
  user: Types.ObjectId; // ref user
  userInfoSnapshot: TUserInfoSnapshot;
  items: IOrderItem[];
  totalAmount: number;
  paymentMethod: TPaymentMethod;
  paymentStatus: TPaymentStatus;
  orderStatus: TOrderStatus;
  transactionId?: string;
  txHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TOrder = IOrder;

const OrderItemSchema = new Schema<IOrderItem>(
  {
    item: {
      type: Schema.Types.ObjectId,
      ref: 'Item',
      required: true,
    },
    title: { type: String, required: true },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    discountPercent: { type: Number },
    selectedOptions: [
      {
        group: { type: String, required: true },
        name: { type: String, required: true },
        extraPrice: { type: Number },
      },
    ],
  },
  { _id: false },
);

const OrderSchema = new Schema<TOrder>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    userInfoSnapshot: {
      name: { type: String },
      address: { type: String },
      phoneNumber: { type: String },
      email: { type: String, required: true },
    },
    items: { type: [OrderItemSchema], required: true },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentMethod: {
      type: String,
      enum: ['momo', 'cod', 'crypto'],
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'success', 'failed'],
      default: 'pending',
    },
    orderStatus: {
      type: String,
      enum: ['pending', 'completed', 'delivering', 'completed', 'cancelled'],
      default: 'pending',
    },
    transactionId: { type: String },
    txHash: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ user: 1, status: 1 });

export const Order = mongoose.models.Order || model<TOrder>('Order', OrderSchema);
