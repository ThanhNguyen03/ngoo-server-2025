import { PaginationInput, Resolvers } from '@/generated/graphql';
import { publicWrapper, schemaPagination, TPagination } from '@/helper';
import { CategoryModel, ItemModel } from '@/model';
import Joi from 'joi';

enum EItemQuery {
  Status = 'status',
  Price = 'price',
}
const JOI_LIST_ITEM = Joi.object<TPagination>({
  ...schemaPagination(Object.values(EItemQuery)),
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

      const listItem = await ItemModel.find().skip(offset).limit(limit).sort(sort).lean();

      const records = listItem.map((item) => ({
        itemId: item.itemId,
        name: item.name,
        image: item.image,
        price: item.price,
        amount: item.amount,
        description: item.description,
        discountPercent: item.discountPercent,
        requireOption: item.requireOption,
        additionalOption: item.additionalOption,
        status: item.status,
        createdAt: item.createdAt.getTime(),
        updatedAt: item.updatedAt.getTime(),
        categoryName: item.categoryName,
      }));

      return {
        offset: offset,
        limit: offset,
        query: query,
        total: listItem.length || 0,
        records,
      };
    }),
  },
  Mutation: {},
};
