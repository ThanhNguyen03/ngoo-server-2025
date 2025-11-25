import {
  EItemStatus,
  MutationCreateItemArgs,
  MutationDeleteItemArgs,
  MutationUpdateItemArgs,
  QueryItemByCategoryArgs,
  QueryItemByIdArgs,
  Resolvers,
  TItemResponse,
} from '@generated/graphql';
import {
  adminWrapper,
  JOI_ID_SCHEMA,
  publicWrapper,
  RedisHelper,
  schemaPagination,
  sortQuery,
  TPagination,
} from '@helper';
import { CategoryModel, ItemModel, TCategory } from '@model';
import Joi from 'joi';
import { Types } from 'mongoose';

enum EItemQuery {
  Status = 'status',
  Price = 'price',
}
export const JOI_ITEM_OPTION = Joi.object({
  group: Joi.string().trim().min(1).max(50).required(),
  name: Joi.string().trim().min(1).max(50).required(),
  extraPrice: Joi.number().min(0),
});

const JOI_ITEM_INPUT_BASE = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  image: Joi.string().uri().required(),
  price: Joi.number().min(0).required(),
  description: Joi.string().allow('', null),
  discountPercent: Joi.number().min(0).max(100).allow(null),
  requireOption: Joi.array().items(JOI_ITEM_OPTION).default([]),
  additionalOption: Joi.array().items(JOI_ITEM_OPTION).default([]),
  status: Joi.array().items(Joi.string().valid(...Object.values(EItemStatus))),
  categoryName: Joi.string().trim().min(5).max(30).required(),
});

// Joi validate for create item mutation
const JOI_CREATE_ITEM_INPUT = Joi.object<MutationCreateItemArgs>({
  input: JOI_ITEM_INPUT_BASE,
});

// Joi validate for update item mutation
const JOI_UPDATE_ITEM_INPUT = Joi.object<MutationUpdateItemArgs>({
  input: JOI_ITEM_INPUT_BASE.keys({
    itemId: JOI_ID_SCHEMA.required(),
  }),
});

const JOI_ITEM_ID = Joi.object<MutationDeleteItemArgs>({
  itemId: JOI_ID_SCHEMA,
});

const JOI_ITEM_BY_CATEGORY_ID = Joi.object<QueryItemByCategoryArgs>({
  offset: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  categoryName: Joi.string().trim().min(5).max(30).required(),
  limit: Joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER).default(20),
});
const JOI_ITEM_BY_ID = Joi.object<QueryItemByIdArgs>({
  itemId: JOI_ID_SCHEMA,
});

const JOI_LIST_ITEM = Joi.object<Omit<TPagination, 'total'>>({
  ...schemaPagination(Object.values(EItemQuery)),
});

export const resolverItem: Resolvers = {
  Query: {
    listItem: publicWrapper(JOI_LIST_ITEM, async (_root, _args) => {
      const { offset, limit, query } = _args;
      const sort = sortQuery(query);

      const [listItem, total] = await Promise.all([
        ItemModel.find({ isDeleted: false })
          .populate<{ category: TCategory }>('category')
          .skip(offset)
          .limit(limit)
          .sort(sort)
          .lean(),
        ItemModel.countDocuments({ isDeleted: false }),
      ]);

      return {
        offset,
        limit,
        query,
        total,
        records: listItem.map((item) => {
          return {
            itemId: item.itemId,
            name: item.name,
            image: item.image,
            price: item.price,
            description: item.description,
            discountPercent: item.discountPercent,
            requireOption: item.requireOption,
            additionalOption: item.additionalOption,
            status: item.status,
            categoryName: item.category.name,
            createdAt: item.createdAt.getTime(),
            updatedAt: item.updatedAt.getTime(),
          };
        }),
      };
    }),

    itemByCategory: publicWrapper(JOI_ITEM_BY_CATEGORY_ID, async (_root, _args) => {
      const { offset = 0, limit = 20, categoryName } = _args;
      const category = await CategoryModel.findOne({ name: categoryName, isDeleted: false }).lean();
      if (!category) {
        throw new Error('Category not found');
      }

      const [listItem, total] = await Promise.all([
        ItemModel.find({ isDeleted: false, category: category._id })
          .populate<{ category: TCategory }>('category')
          .skip(offset ?? 0)
          .limit(limit ?? 20)
          .sort({ createdAt: -1 })
          .lean(),
        ItemModel.countDocuments({ isDeleted: false, category: category._id }),
      ]);

      return {
        offset: offset ?? 0,
        limit: limit ?? 20,
        total,
        query: [],
        records: listItem.map((item) => {
          return {
            itemId: item.itemId,
            name: item.name,
            image: item.image,
            price: item.price,
            description: item.description,
            discountPercent: item.discountPercent,
            requireOption: item.requireOption,
            additionalOption: item.additionalOption,
            status: item.status,
            categoryName: item.category.name,
            createdAt: item.createdAt.getTime(),
            updatedAt: item.updatedAt.getTime(),
          };
        }),
      };
    }),

    itemById: publicWrapper(JOI_ITEM_BY_ID, async (_root, _args) => {
      const { itemId } = _args;
      const cacheItemById = await RedisHelper.item.itemByIdGet(itemId);
      if (cacheItemById) {
        return {
          itemId: cacheItemById.itemId,
          name: cacheItemById.name,
          image: cacheItemById.image,
          price: cacheItemById.price,
          description: cacheItemById.description,
          discountPercent: cacheItemById.discountPercent,
          requireOption: cacheItemById.requireOption,
          additionalOption: cacheItemById.additionalOption,
          status: cacheItemById.status,
          categoryName: cacheItemById.categoryName,
          createdAt: cacheItemById.createdAt,
          updatedAt: cacheItemById.updatedAt,
        };
      }
      const result = await ItemModel.findOne({ itemId, isDeleted: false })
        .populate<{ category: TCategory }>('category')
        .exec();
      if (!result) {
        throw new Error('Item not found!');
      }

      const response = {
        itemId: result.itemId,
        name: result.name,
        image: result.image,
        price: result.price,
        description: result.description,
        discountPercent: result.discountPercent,
        requireOption: result.requireOption,
        additionalOption: result.additionalOption,
        status: result.status,
        categoryName: result.category.name,
        createdAt: result.createdAt.getTime(),
        updatedAt: result.updatedAt.getTime(),
      };

      await RedisHelper.item.itemByIdSet(response);
      return response;
    }),
  },

  Mutation: {
    createItem: adminWrapper(JOI_CREATE_ITEM_INPUT, async (_root, { input }) => {
      const { categoryName, name, ...data } = input;
      const category = await CategoryModel.findOne({ name: categoryName, isDeleted: false }).lean();
      if (!category) {
        throw new Error('Category not found');
      }

      const existingItem = await ItemModel.findOne({
        name,
        isDeleted: false,
      });

      if (existingItem) {
        throw new Error('Item already exist!');
      }

      const item = await ItemModel.findOneAndUpdate(
        { name },
        {
          $setOnInsert: {
            ...data,
            name,
            category: category._id,
          }, // if donot have -> create new
          $set: { isDeleted: false }, // if isDelete = true -> set false
        },
        { new: true, upsert: true },
      )
        .populate<{ category: TCategory }>('category')
        .exec();

      if (!item) {
        throw new Error('Failed to create item');
      }

      const response = {
        itemId: item.itemId,
        name: item.name,
        image: item.image,
        price: item.price,
        description: item.description,
        discountPercent: item.discountPercent,
        requireOption: item.requireOption,
        additionalOption: item.additionalOption,
        status: item.status,
        categoryName: item.category.name,
        createdAt: item.createdAt.getTime(),
        updatedAt: item.updatedAt.getTime(),
      };
      await RedisHelper.item.itemByIdSet(response);

      return response;
    }),

    updateItem: adminWrapper(JOI_UPDATE_ITEM_INPUT, async (_root, { input }) => {
      const { categoryName, itemId, ...data } = input;

      const existingItem = await ItemModel.findOne({ itemId, isDeleted: false })
        .populate<{ category: TCategory }>('category')
        .exec();
      if (!existingItem) {
        throw new Error('Item not found!');
      }

      let newCategoryId: Types.ObjectId | undefined;
      if (categoryName) {
        const category = await CategoryModel.findOne({ name: categoryName, isDeleted: false }).lean();
        if (!category) {
          throw new Error('Category not found');
        }
        newCategoryId = category._id;
      }

      const item = await ItemModel.findOneAndUpdate(
        { itemId, isDeleted: false },
        { ...data, ...(newCategoryId ? { category: newCategoryId } : {}) },
        { new: true },
      )
        .populate<{ category: TCategory }>('category')
        .exec();

      if (!item) {
        throw new Error('Failed to update item!');
      }

      const response: TItemResponse = {
        itemId: item.itemId,
        name: item.name,
        image: item.image,
        price: item.price,
        description: item.description,
        discountPercent: item.discountPercent,
        requireOption: item.requireOption,
        additionalOption: item.additionalOption,
        status: item.status,
        categoryName: item.category.name,
        createdAt: item.createdAt.getTime(),
        updatedAt: item.updatedAt.getTime(),
      };

      await RedisHelper.item.itemByIdSet(response);

      return response;
    }),

    deleteItem: adminWrapper(JOI_ITEM_ID, async (_root, _arg) => {
      const { itemId } = _arg;
      const item = await ItemModel.findOneAndUpdate({ itemId }, { isDeleted: true }, { new: true });
      if (!item) {
        throw new Error('Item not found');
      }
      await RedisHelper.item.itemByIdDel(itemId);
      return true;
    }),
  },
};
