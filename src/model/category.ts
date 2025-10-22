import mongoose, { Document, model, Schema } from 'mongoose';

interface ICategory extends Document {
  name: string;
  createAt: Date;
}

export type TCategory = ICategory;

const CategorySchema = new Schema<TCategory>(
  {
    name: { type: String, require: true, unique: true },
  },
  { timestamps: true, versionKey: false },
);

CategorySchema.index({ name: 1 });

export const CategoryModel = mongoose.models.Category || model<TCategory>('Category', CategorySchema);
