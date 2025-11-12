import {
  EItemStatus,
  MutationCreateItemArgs,
  MutationDeleteItemArgs,
  MutationUpdateItemArgs,
  QueryGetItemByCategoryArgs,
  Resolvers,
} from '@generated/graphql';
import { adminWrapper, JOI_ID_SCHEMA, publicWrapper, schemaPagination, sortQuery, TPagination } from '@helper';
import { CategoryModel, ItemModel, TCategory, TItem } from '@model';
import Joi from 'joi';

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

const returnResponse = (item: TItem) => ({
  itemId: item.itemId,
  name: item.name,
  image: item.image,
  price: item.price,
  description: item.description,
  discountPercent: item.discountPercent,
  requireOption: item.requireOption,
  additionalOption: item.additionalOption,
  status: item.status,
  category: item.category,
  createdAt: item.createdAt.getTime(),
  updatedAt: item.updatedAt.getTime(),
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

    getItemByCategory: publicWrapper(JOI_ITEM_BY_CATEGORY_ID, async (_root, _args) => {
      const { categoryId } = _args;
      const result = await ItemModel.findOne({ categoryId }).populate<{ category: TCategory }>('category').exec();
      if (!result) {
        throw new Error('Item not found!');
      }
      return {
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
            category: category._id,
          }, // if donot have -> create new
          $set: { isDeleted: false }, // if isDelete = true -> set false
        },
        { new: true, upsert: true },
      )
        .populate<{ category: TCategory }>('category')
        .exec();

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
      )
        .populate<{ category: TCategory }>('category')
        .exec();

      if (!item) {
        throw new Error('Item not found!');
      }

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
