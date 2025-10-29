import {
  MutationCreateCategoryArgs,
  MutationDeleteCategoryArgs,
  MutationUpdateCategoryArgs,
  Resolvers,
} from '@/generated/graphql';
import { adminWrapper, JOI_ID_SCHEMA } from '@/helper';
import { CategoryModel } from '@/model';
import Joi from 'joi';

const JOI_CATEGORY_NAME = Joi.object<MutationCreateCategoryArgs>({
  name: Joi.string().alphanum().trim().min(5).max(30),
});
const JOI_CATEGORY = Joi.object<MutationUpdateCategoryArgs>({
  category: Joi.object({
    categoryId: JOI_ID_SCHEMA,
    name: Joi.string().alphanum().trim().min(5).max(30).required(),
  }),
});
const JOI_CATEGORY_ID = Joi.object<MutationDeleteCategoryArgs>({
  categoryId: Joi.string()
    .alphanum()
    .trim()
    .guid({
      version: ['uuidv4'],
    }),
});

export const resolverCategory: Resolvers = {
  Query: {
    listCategory: async () => {
      // return categories werenot deleted
      const listCategory = await CategoryModel.find({ isDeleted: false });
      return listCategory.map((item) => ({ categoryId: item.categoryId, name: item.name }));
    },
  },

  Mutation: {
    createCategory: adminWrapper(JOI_CATEGORY_NAME, async (_root, _arg) => {
      const { name } = _arg;

      const category = await CategoryModel.findOneAndUpdate(
        { name },
        {
          $setOnInsert: { name }, // if donot have -> create new
          $set: { isDeleted: false }, // if isDelete = true -> set false
        },
        { new: true, upsert: true },
      );

      const existingActive = await CategoryModel.findOne({
        name,
        isDeleted: false,
        _id: { $ne: category._id },
      });

      if (existingActive) {
        throw new Error('Category already exist!');
      }

      return {
        categoryId: category.categoryId,
        name: category.name,
      };
    }),

    updateCategory: adminWrapper(JOI_CATEGORY, async (_root, _arg) => {
      const { categoryId, name } = _arg.category;
      const category = await CategoryModel.findOneAndUpdate(
        { _id: categoryId, isDeleted: false },
        { name },
        { new: true },
      );

      if (!category) {
        throw new Error('Category not found');
      }

      return {
        categoryId: category.categoryId,
        name: category.name,
      };
    }),

    deleteCategory: adminWrapper(JOI_CATEGORY_ID, async (_root, _arg) => {
      const { categoryId } = _arg;
      const category = await CategoryModel.findOneAndUpdate({ categoryId }, { isDeleted: true }, { new: true });

      if (!category) {
        throw new Error('Category not found');
      }

      return true;
    }),
  },
};
