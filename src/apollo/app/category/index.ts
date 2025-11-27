import {
  MutationCreateCategoryArgs,
  MutationDeleteCategoryArgs,
  MutationUpdateCategoryArgs,
  Resolvers,
} from '@generated/graphql';
import { adminWrapper, JOI_ID_SCHEMA, publicWrapper, RedisHelper } from '@helper';
import { CategoryModel } from '@model';
import Joi from 'joi';

const JOI_CATEGORY_NAME = Joi.object<MutationCreateCategoryArgs>({
  name: Joi.string().alphanum().trim().min(5).max(30),
});
const JOI_CATEGORY = Joi.object<MutationUpdateCategoryArgs>({
  category: Joi.object({
    categoryId: JOI_ID_SCHEMA,
    name: Joi.string().trim().min(5).max(30).required(),
  }),
});
const JOI_CATEGORY_ID = Joi.object<MutationDeleteCategoryArgs>({
  categoryId: JOI_ID_SCHEMA,
});

export const resolverCategory: Resolvers = {
  Query: {
    listCategory: publicWrapper(async () => {
      const cachedListCategory = await RedisHelper.category.categoryAllListGet();
      if (cachedListCategory && cachedListCategory.length > 0) {
        return cachedListCategory;
      }
      const listCategory = await CategoryModel.find({ isDeleted: false });
      const response = listCategory.map((item) => ({ categoryId: item.categoryId, name: item.name }));
      await RedisHelper.category.categoryAllListSet(response);

      return response;
    }),
  },

  Mutation: {
    createCategory: adminWrapper(JOI_CATEGORY_NAME, async (_root, _arg) => {
      const { name } = _arg;
      const cacheCategory = await RedisHelper.category.categoryGet(name);
      if (cacheCategory) {
        throw new Error('Category already exist!');
      }

      const existingActive = await CategoryModel.findOne({
        name,
        isDeleted: false,
      });
      if (existingActive) {
        const response = {
          categoryId: existingActive.categoryId,
          name: existingActive.name,
        };
        await RedisHelper.category.categorySet(response);
        throw new Error('Category already exist!');
      }
      const category = await CategoryModel.findOneAndUpdate(
        { name },
        {
          $setOnInsert: { name }, // if donot have -> create new
          $set: { isDeleted: false }, // if isDelete = true -> set false
        },
        { new: true, upsert: true },
      );

      const response = {
        categoryId: category.categoryId,
        name: category.name,
      };
      await RedisHelper.category.categorySet(response);

      return response;
    }),

    updateCategory: adminWrapper(JOI_CATEGORY, async (_root, _arg) => {
      const { categoryId, name } = _arg.category;

      const oldCategory = await CategoryModel.findOne({ categoryId, isDeleted: false });
      if (!oldCategory) {
        throw new Error('Category not found');
      }

      // Update cache
      if (oldCategory.name !== name) {
        oldCategory.name = name;
        await oldCategory.save();
        await RedisHelper.category.categoryDel(oldCategory.name);
      }

      const response = {
        categoryId: oldCategory.categoryId,
        name,
      };

      await RedisHelper.category.categorySet(response);

      return response;
    }),

    deleteCategory: adminWrapper(JOI_CATEGORY_ID, async (_root, _arg) => {
      const { categoryId } = _arg;
      const category = await CategoryModel.findOneAndUpdate({ categoryId }, { isDeleted: true }, { new: true });

      if (!category) {
        throw new Error('Category not found');
      }
      await RedisHelper.category.categoryDel(category.name);
      return true;
    }),
  },
};
