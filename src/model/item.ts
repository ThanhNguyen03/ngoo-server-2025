// models/Item.model.ts
import { EItemStatus } from '@/generated/graphql';
import { randomUUID } from 'crypto';
import { Schema, model } from 'mongoose';

export type TItemOption = {
  group: string;
  name: string;
  extraPrice?: number;
};

interface IItem {
  itemId: string;
  name: string;
  image: string;
  price: number;
  amount: number;
  description: string;
  discountPercent?: number;
  requireOption: TItemOption[];
  additionalOption?: TItemOption[];
  status?: EItemStatus;
  categoryName: string; // Ref to Category
  createdAt: Date;
  updatedAt: Date;
}

export type TItem = IItem;

const ItemOptionSchema = new Schema<TItemOption>(
  {
    group: { type: String, required: true },
    name: { type: String, required: true },
    extraPrice: { type: Number },
  },
  { _id: false }, // donot create id for child options
);

const ItemSchema = new Schema<IItem>(
  {
    itemId: { type: String, required: true, unique: true, default: () => randomUUID() },
    name: { type: String, required: true },
    image: { type: String, required: true },
    price: { type: Number, required: true },
    amount: { type: Number, default: 0 },
    description: { type: String, required: true },
    discountPercent: { type: Number },
    requireOption: { type: [ItemOptionSchema], required: true },
    additionalOption: { type: [ItemOptionSchema], required: false },
    status: { type: String, enum: ['NEW', 'SELLER', 'EMPTY'], default: '' },
    categoryName: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

export const ItemModel = model<TItem>('Item', ItemSchema);
