import {
  EItemStatus,
  ItemOptionInput,
  MutationCreateItemArgs,
  MutationDeleteItemArgs,
  MutationUpdateItemArgs,
  QueryGetItemByCategoryArgs,
  Resolvers,
} from '@/generated/graphql';
import { adminWrapper, JOI_ID_SCHEMA, publicWrapper, schemaPagination, TPagination } from '@/helper';
import { CategoryModel, ItemModel, TItem } from '@/model';
import Joi from 'joi';

enum EItemQuery {
  Status = 'status',
  Price = 'price',
}
const JOI_ITEM_OPTION = Joi.object({
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
  status: Joi.string().valid(...Object.values(EItemStatus)),
  categoryId: JOI_ID_SCHEMA,
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

const JOI_ITEM_BY_CATEGORY_ID = Joi.object<QueryGetItemByCategoryArgs>({
  categoryId: JOI_ID_SCHEMA,
});

const JOI_LIST_ITEM = Joi.object<Omit<TPagination, 'total'>>({
  ...schemaPagination(Object.values(EItemQuery)),
});

const mapItemResponse = (item: TItem) => ({
  itemId: item.itemId,
  name: item.name,
  image: item.image,
  price: item.price,
  description: item.description,
  discountPercent: item.discountPercent,
  requireOption: item.requireOption,
  additionalOption: item.additionalOption,
  status: item.status,
  categoryName: item.categoryName,
  createdAt: item.createdAt.getTime(),
  updatedAt: item.updatedAt.getTime(),
});

export const resolverItem: Resolvers = {
  Query: {
    listItem: publicWrapper(JOI_LIST_ITEM, async (_root, _args) => {
      const { offset, limit, query } = _args;
      const sort: Record<string, 1 | -1> = {};

      for (const q of query) {
        if (q.sort) {
          sort[q.column!] = q.sort === 'asc' ? 1 : -1;
        }
      }
      const [listItem, total] = await Promise.all([
        ItemModel.find({ isDeleted: false }).skip(offset).limit(limit).sort(sort).lean(),
        ItemModel.countDocuments({ isDeleted: false }),
      ]);

      return {
        offset,
        limit,
        query,
        total,
        records: listItem.map(mapItemResponse),
      };
    }),

    getItemByCategory: publicWrapper(JOI_ITEM_BY_CATEGORY_ID, async (_root, _args) => {
      const { categoryId } = _args;
      const result = await ItemModel.findOne({ categoryId });
      if (!result) {
        throw new Error('Item not found!');
      }
      return mapItemResponse(result);
    }),
  },

  Mutation: {
    createItem: adminWrapper(JOI_CREATE_ITEM_INPUT, async (_root, { input }) => {
      // TODO: get categoryId from redis cache
      const category = await CategoryModel.findOne({ categoryId: input.categoryId, isDeleted: false });
      if (!category) {
        throw new Error('Category not found');
      }

      const existingItem = await ItemModel.findOne({
        name: input.name,
        isDeleted: false,
      });

      if (existingItem) {
        throw new Error('Item already exist!');
      }

      const item = await ItemModel.findOneAndUpdate(
        { name: input.name },
        {
          $setOnInsert: {
            ...input,
            categoryName: category.name,
          }, // if donot have -> create new
          $set: { isDeleted: false }, // if isDelete = true -> set false
        },
        { new: true, upsert: true },
      );

      return mapItemResponse(item);
    }),

    updateItem: adminWrapper(JOI_UPDATE_ITEM_INPUT, async (_root, { input }) => {
      // TODO: get categoryId from redis cache
      const category = await CategoryModel.findOne({ categoryId: input.categoryId, isDeleted: false });
      if (!category) {
        throw new Error('Category not found');
      }
      const item = await ItemModel.findOneAndUpdate(
        { itemId: input.itemId, isDeleted: false },
        { ...input, categoryName: category.name },
        { new: true },
      );

      if (!item) {
        throw new Error('Item not found!');
      }

      return mapItemResponse(item);
    }),

    deleteItem: adminWrapper(JOI_ITEM_ID, async (_root, _arg) => {
      const { itemId } = _arg;
      const item = await ItemModel.findOneAndUpdate({ itemId }, { isDeleted: true }, { new: true });

      if (!item) {
        throw new Error('Item not found');
      }

      return true;
    }),
  },
};
