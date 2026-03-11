import {
  EItemStatus,
  MutationCreateItemArgs,
  MutationDeleteItemArgs,
  MutationUpdateItemArgs,
  QueryItemByIdArgs,
  QueryListItemByCategoryArgs,
  QueryListItemByStatusArgs,
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
import { ConflictError, NotFoundError } from '@lib';
import { CategoryModel, ItemModel, TCategory, TItem } from '@model';
import Joi from 'joi';
import { Types } from 'mongoose';

/**
 * Minimum shape required by the mapper — compatible with both lean and
 * hydrated Mongoose results. Using `Omit<TItem, 'category'>` removes the raw
 * `ObjectId` ref field and replaces it with `{ name: string }`, which is a
 * structural subset of `FlattenMaps<TCategory>` (lean) and `TCategory`
 * (hydrated). This avoids the ObjectId vs FlattenMaps mismatch that
 * TypeScript reports when using `.lean()` with `.populate()`.
 */
type TItemMappable = Omit<TItem, 'category'> & { category: Pick<TCategory, 'name'> };

/**
 * Map a Mongoose item document (with populated category) to the GraphQL
 * `TItemResponse` type. Centralises the mapping to avoid repeating the same
 * field assignments across every query and mutation resolver.
 *
 * Note: `createdAt` / `updatedAt` are converted from `Date` to Unix timestamps
 * (milliseconds) so they match the GraphQL `Int` scalar type.
 *
 * @param item - Lean or hydrated item document with `category` populated.
 */
const toItemResponse = (item: TItemMappable): TItemResponse => ({
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
});

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

const JOI_ITEM_BY_CATEGORY_ID = Joi.object<QueryListItemByCategoryArgs>({
  offset: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  categoryName: Joi.string().trim().min(5).max(30).required(),
  limit: Joi.number().integer().min(1).max(100).default(20),
});
const JOI_ITEM_BY_CATEGORY_STATUS = Joi.object<QueryListItemByStatusArgs>({
  offset: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  status: Joi.array()
    .items(Joi.string().valid(...Object.values(EItemStatus)))
    .required(),
  limit: Joi.number().integer().min(1).max(100).default(20),
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
        records: listItem.map(toItemResponse),
      };
    }),

    listItemByCategory: publicWrapper(JOI_ITEM_BY_CATEGORY_ID, async (_root, _args) => {
      const { offset = 0, limit = 20, categoryName } = _args;
      const category = await CategoryModel.findOne({ name: categoryName, isDeleted: false }).lean();
      if (!category) {
        throw new NotFoundError('Category not found');
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
        records: listItem.map(toItemResponse),
      };
    }),

    listItemByStatus: publicWrapper(JOI_ITEM_BY_CATEGORY_STATUS, async (_root, _args) => {
      const { offset = 0, limit = 20, status } = _args;

      const filter = {
        isDeleted: false,
        status: { $in: status },
      };

      const [listItem, total] = await Promise.all([
        ItemModel.find(filter)
          .populate<{ category: TCategory }>('category')
          .skip(offset ?? 0)
          .limit(limit ?? 20)
          .sort({ createdAt: -1 })
          .lean(),
        ItemModel.countDocuments(filter),
      ]);

      return {
        offset: offset ?? 0,
        limit: limit ?? 20,
        total,
        query: [],
        records: listItem.map(toItemResponse),
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
        throw new NotFoundError('Item not found');
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
        throw new NotFoundError('Category not found');
      }

      const existingItem = await ItemModel.findOne({
        name,
        isDeleted: false,
      });

      if (existingItem) {
        throw new ConflictError('Item already exists');
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
        throw new NotFoundError('Failed to create item');
      }

      const response = toItemResponse(item);
      await RedisHelper.item.itemByIdSet(response);

      return response;
    }),

    updateItem: adminWrapper(JOI_UPDATE_ITEM_INPUT, async (_root, { input }) => {
      const { categoryName, itemId, ...data } = input;

      const existingItem = await ItemModel.findOne({ itemId, isDeleted: false })
        .populate<{ category: TCategory }>('category')
        .exec();
      if (!existingItem) {
        throw new NotFoundError('Item not found');
      }

      let newCategoryId: Types.ObjectId | undefined;
      if (categoryName) {
        const category = await CategoryModel.findOne({ name: categoryName, isDeleted: false }).lean();
        if (!category) {
          throw new NotFoundError('Category not found');
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
        throw new NotFoundError('Failed to update item');
      }

      const response = toItemResponse(item);

      await RedisHelper.item.itemByIdSet(response);

      return response;
    }),

    deleteItem: adminWrapper(JOI_ITEM_ID, async (_root, _args) => {
      const { itemId } = _args;
      const item = await ItemModel.findOneAndUpdate({ itemId }, { isDeleted: true }, { new: true });
      if (!item) {
        throw new NotFoundError('Item not found');
      }
      await RedisHelper.item.itemByIdDel(itemId);
      return true;
    }),
  },
};
