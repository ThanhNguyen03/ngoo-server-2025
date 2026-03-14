import {
  EItemStatus,
  MutationCreateItemArgs,
  MutationDeleteItemArgs,
  MutationUpdateItemArgs,
  QueryItemByIdArgs,
  QueryListItemByCategoryArgs,
  QueryListItemByStatusArgs,
  QueryListItemCursorArgs,
  Resolvers,
  TItemResponse,
} from '@generated/graphql';
import {
  adminWrapper,
  JOI_ID_SCHEMA,
  publicRateLimitWrapper,
  publicWrapper,
  RATE_LIMIT_CONFIGS,
  rateLimitWrapper,
  RedisHelper,
  schemaPagination,
  sortQuery,
  TPagination,
} from '@helper';
import { ConflictError, NotFoundError, ValidationError } from '@lib';
import { CategoryModel, ItemModel, TCategory, TItem } from '@model';
import { logAudit } from '@service';
import Joi from 'joi';
import { Types } from 'mongoose';

/** Encode a cursor from a document's createdAt timestamp and _id. */
const encodeCursor = (createdAt: Date, id: Types.ObjectId): string => {
  return Buffer.from(JSON.stringify({ t: createdAt.getTime(), id: id.toHexString() })).toString('base64url');
};

/** Decode a cursor string into { t: timestamp_ms, id: hex_string }. Returns null on invalid input. */
const decodeCursor = (cursor: string): { t: number; id: string } | null => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed.t !== 'number' || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
};

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
  description: Joi.string().max(5000).allow('', null),
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

const JOI_LIST_ITEM_CURSOR = Joi.object<QueryListItemCursorArgs>({
  limit: Joi.number().integer().min(1).max(100).default(20),
  cursor: Joi.string().allow(null, '').default(null),
  categoryName: Joi.string().trim().min(5).max(30).allow(null),
  status: Joi.array()
    .items(Joi.string().valid(...Object.values(EItemStatus)))
    .allow(null),
});

export const resolverItem: Resolvers = {
  Query: {
    listItem: publicWrapper(
      JOI_LIST_ITEM,
      publicRateLimitWrapper(RATE_LIMIT_CONFIGS.PUBLIC_QUERY, async (_root, _args) => {
      const { offset, limit, query } = _args;
      const sort = sortQuery(query);

      // Short-TTL cache (30s) for item list — reduces DB load on high-traffic public endpoints.
      const cacheKey = `all:${offset}:${limit}:${JSON.stringify(sort)}`;
      const cached = await RedisHelper.item.itemListGet(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const [listItem, total] = await Promise.all([
        ItemModel.find({ isDeleted: false })
          .populate<{ category: TCategory }>('category')
          .skip(offset)
          .limit(limit)
          .sort(sort)
          .lean(),
        ItemModel.countDocuments({ isDeleted: false }),
      ]);

      const result = {
        offset,
        limit,
        query,
        total,
        records: listItem.map(toItemResponse),
      };

      await RedisHelper.item.itemListSet(cacheKey, JSON.stringify(result));

      return result;
    }, 'ip:query')),

    listItemByCategory: publicWrapper(
      JOI_ITEM_BY_CATEGORY_ID,
      publicRateLimitWrapper(RATE_LIMIT_CONFIGS.PUBLIC_QUERY, async (_root, _args) => {
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
    }, 'ip:query')),

    listItemByStatus: publicWrapper(
      JOI_ITEM_BY_CATEGORY_STATUS,
      publicRateLimitWrapper(RATE_LIMIT_CONFIGS.PUBLIC_QUERY, async (_root, _args) => {
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
    }, 'ip:query')),

    listItemCursor: publicWrapper(
      JOI_LIST_ITEM_CURSOR,
      publicRateLimitWrapper(RATE_LIMIT_CONFIGS.PUBLIC_QUERY, async (_root, _args) => {
      // Joi defaults ensure limit is always a number after validation
      const limit = _args.limit ?? 20;
      const { cursor, categoryName, status } = _args;
      const filter: Record<string, unknown> = { isDeleted: false };

      // Optional category filter
      if (categoryName) {
        const category = await CategoryModel.findOne({ name: categoryName, isDeleted: false }).lean();
        if (!category) throw new NotFoundError('Category not found');
        filter.category = category._id;
      }

      // Optional status filter
      if (status && status.length > 0) {
        filter.status = { $in: status };
      }

      // Cursor condition: fetch documents older than the cursor position
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (!decoded) throw new ValidationError('Invalid cursor format');

        const cursorDate = new Date(decoded.t);
        const cursorObjectId = new Types.ObjectId(decoded.id);
        filter.$or = [{ createdAt: { $lt: cursorDate } }, { createdAt: cursorDate, _id: { $lt: cursorObjectId } }];
      }

      // Fetch limit + 1 to determine if there are more results
      const items = await ItemModel.find(filter)
        .populate<{ category: TCategory }>('category')
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = items.length > limit;
      const pageItems = hasMore ? items.slice(0, limit) : items;

      const nextCursor =
        hasMore && pageItems.length > 0
          ? encodeCursor(pageItems[pageItems.length - 1].createdAt, pageItems[pageItems.length - 1]._id)
          : null;

      return {
        records: pageItems.map(toItemResponse),
        pageInfo: { hasMore, nextCursor },
      };
    }, 'ip:query')),

    itemById: publicWrapper(
      JOI_ITEM_BY_ID,
      publicRateLimitWrapper(RATE_LIMIT_CONFIGS.PUBLIC_QUERY, async (_root, _args) => {
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
    }, 'ip:query')),
  },

  Mutation: {
    createItem: adminWrapper(
      JOI_CREATE_ITEM_INPUT,
      rateLimitWrapper(RATE_LIMIT_CONFIGS.ADMIN_MUTATION, async (_root, { input }, context) => {
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
        await RedisHelper.item.itemListInvalidate();

        // Fire-and-forget: do not await to avoid blocking the response
        logAudit({
          userId: context.user.userId,
          action: 'CREATE',
          targetType: 'Item',
          targetId: item.itemId,
          metadata: { name: item.name, categoryName: item.category.name },
        });

        return response;
      }),
    ),

    updateItem: adminWrapper(
      JOI_UPDATE_ITEM_INPUT,
      rateLimitWrapper(RATE_LIMIT_CONFIGS.ADMIN_MUTATION, async (_root, { input }, context) => {
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
        await RedisHelper.item.itemListInvalidate();

        // Fire-and-forget: do not await to avoid blocking the response
        logAudit({
          userId: context.user.userId,
          action: 'UPDATE',
          targetType: 'Item',
          targetId: item.itemId,
          metadata: { name: item.name },
        });

        return response;
      }),
    ),

    deleteItem: adminWrapper(
      JOI_ITEM_ID,
      rateLimitWrapper(RATE_LIMIT_CONFIGS.ADMIN_MUTATION, async (_root, _args, context) => {
        const { itemId } = _args;
        const item = await ItemModel.findOneAndUpdate({ itemId }, { isDeleted: true }, { new: true });
        if (!item) {
          throw new NotFoundError('Item not found');
        }
        await RedisHelper.item.itemByIdDel(itemId);
        await RedisHelper.item.itemListInvalidate();

        // Fire-and-forget: do not await to avoid blocking the response
        logAudit({
          userId: context.user.userId,
          action: 'DELETE',
          targetType: 'Item',
          targetId: itemId,
          metadata: { name: item.name },
        });

        return true;
      }),
    ),
  },
};
