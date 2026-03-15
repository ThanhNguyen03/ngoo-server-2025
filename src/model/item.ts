// models/Item.model.ts
import { EItemStatus } from '@generated/graphql';
import { randomUUID } from 'crypto';
import { Schema, Types, model } from 'mongoose';

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
  description: string;
  discountPercent?: number;
  requireOption: TItemOption[];
  additionalOption?: TItemOption[];
  status?: EItemStatus[];
  category: Types.ObjectId; // Ref to Category
  isDeleted: boolean;
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
    name: { type: String, required: true, unique: true },
    image: { type: String, required: true },
    price: { type: Number, required: true },
    description: { type: String, required: true },
    discountPercent: { type: Number },
    requireOption: { type: [ItemOptionSchema], required: true },
    additionalOption: { type: [ItemOptionSchema] },
    status: [{ type: String, enum: Object.values(EItemStatus) }],
    isDeleted: { type: Boolean, default: false },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
  },
  { timestamps: true },
);

// Compound indexes for common query patterns — each covers isDeleted (equality)
// followed by the secondary filter/sort field(s) to avoid collection scans.
ItemSchema.index({ isDeleted: 1, createdAt: -1 }); // listItem
ItemSchema.index({ isDeleted: 1, category: 1, createdAt: -1 }); // listItemByCategory
ItemSchema.index({ isDeleted: 1, status: 1, createdAt: -1 }); // listItemByStatus
// Text index for full-text search — name weighted 10x over description.
// default_language: 'none' disables stemming for non-English product names.
ItemSchema.index(
  { name: 'text', description: 'text' },
  // eslint-disable-next-line camelcase
  { weights: { name: 10, description: 1 }, default_language: 'none' },
);

export const ItemModel = model<TItem>('Item', ItemSchema);
