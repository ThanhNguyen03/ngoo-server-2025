import { randomUUID } from 'crypto';
import { model, Schema } from 'mongoose';

interface ICategory {
  categoryId: string;
  name: string;
  isDeleted: boolean;
}

export type TCategory = ICategory;

const CategorySchema = new Schema<TCategory>(
  {
    categoryId: { type: String, required: true, default: () => randomUUID() },
    name: { type: String, require: true, unique: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);

export const CategoryModel = model<TCategory>('Category', CategorySchema);
