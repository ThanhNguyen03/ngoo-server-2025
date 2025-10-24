// models/Item.model.ts
import mongoose, { Schema, Document, model, Types } from 'mongoose';

export type TItemOption = {
  group: string;
  name: string;
  extraPrice?: number;
};

export type TItemStatus = 'NEW' | 'SELLER' | 'EMPTY';

interface IItem extends Document {
  name: string;
  image: string;
  price: number;
  amount: number;
  description: string;
  discountPercent?: number;
  requireOption: TItemOption[];
  additionalOption?: TItemOption[];
  note?: string;
  status?: TItemStatus;
  category: Types.ObjectId; // Ref to Category
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
    name: { type: String, required: true },
    image: { type: String, required: true },
    price: { type: Number, required: true },
    amount: { type: Number, default: 0 },
    description: { type: String, required: true },
    discountPercent: { type: Number },
    requireOption: { type: [ItemOptionSchema], required: true },
    additionalOption: { type: [ItemOptionSchema], required: false },
    note: { type: String },
    status: { type: String, enum: ['NEW', 'SELLER', 'EMPTY'], default: '' },
    category: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

ItemSchema.index({ title: 1, category: 1 });

export const ItemModel = mongoose.models.Item || model<TItem>('Item', ItemSchema);
