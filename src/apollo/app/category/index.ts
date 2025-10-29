import {
  MutationCreateCategoryArgs,
  MutationDeleteCategoryArgs,
  MutationUpdateCategoryArgs,
  Resolvers,
} from '@/generated/graphql';
import { JOI_ID_SCHEMA, validationWrapper } from '@/helper';
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
      // return categories were deleted
      return await CategoryModel.find({ isDeleted: false });
    },
  },

  Mutation: {
    createCategory: validationWrapper(JOI_CATEGORY_NAME, async (_root, _arg) => {
      const { name } = _arg;
      const category = await CategoryModel.findOne({ name });

      // if donot have -> create new
      if (!category) {
        return await CategoryModel.create({ name });
      }

      // if deleted -> update not delete
      if (category.isDeleted) {
        return await CategoryModel.findOneAndUpdate({ name }, { isDeleted: false }, { new: true });
      }

      // if exist
      throw new Error('Category already exist!');
    }),

    updateCategory: validationWrapper(JOI_CATEGORY, async (_root, _arg) => {
      const { categoryId, name } = _arg.category;
      const category = await CategoryModel.findOne({ categoryId, isDeleted: false });

      if (!category) {
        throw new Error('Category not found');
      }

      // update
      return await CategoryModel.findOneAndUpdate({ categoryId }, { name }, { new: true });
    }),

    deleteCategory: validationWrapper(JOI_CATEGORY_ID, async (_root, _arg) => {
      const { categoryId } = _arg;
      const category = await CategoryModel.findOneAndUpdate({ categoryId }, { isDeleted: true }, { new: true });

      if (!category) {
        throw new Error('Category not found');
      }

      return true;
    }),
  },
};
