import mongoose, { Schema, model, Document, Types } from 'mongoose';
import { TItemOption } from './item';
import { TPaymentMethod } from './payment';
import { randomUUID } from 'crypto';

export type TOrderStatus = 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'DELIVERING';
export type TUserInfoSnapshot = {
  name?: string;
  address: string;
  phoneNumber: string;
  email: string;
};

interface IOrderItem {
  item: Types.ObjectId; // ref Item
  name: string;
  quantity: number;
  price: number;
  discountPercent?: number;
  selectedOptions?: TItemOption[];
}

interface IOrder {
  orderId: string;
  userInfoSnapshot: TUserInfoSnapshot;
  items: IOrderItem[];
  totalPrice: number;
  paymentMethod: TPaymentMethod;
  orderStatus: TOrderStatus;
  transactionId?: string;
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
    name: { type: String, required: true },
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
    orderId: { type: String, required: true, unique: true, default: () => randomUUID() },
    userInfoSnapshot: {
      name: { type: String },
      address: { type: String, required: true },
      phoneNumber: { type: String, required: true },
      email: { type: String, required: true },
    },
    items: { type: [OrderItemSchema], required: true },
    totalPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentMethod: {
      type: String,
      enum: ['momo', 'cod', 'crypto'],
      required: true,
    },
    orderStatus: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'CANCELLED', 'DELIVERING'],
      default: 'PENDING',
    },
    transactionId: { type: String },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ status: 1 });

export const Order = mongoose.models.Order || model<TOrder>('Order', OrderSchema);
