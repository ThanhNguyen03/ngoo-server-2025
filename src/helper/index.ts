import { ESort, OrderItemInput, QueryByInput, TQueryBy } from '@generated/graphql';
import { TItem } from '@model';
import Joi from 'joi';
import { SortOrder } from 'mongoose';

export const USER_ERROR_PREFIX = 'IGNORABLE_ERROR';
export const JOI_ID_SCHEMA = Joi.string()
  .trim()
  .guid({
    version: ['uuidv4'],
  })
  .required();

export type TPagination = { total: number; offset: number; limit: number; query: TQueryBy[] };

export const schemaPagination = (queryList: string[]) => ({
  offset: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  query: Joi.array()
    .items(
      Joi.object<QueryByInput>({
        column: Joi.string()
          .valid(...queryList)
          .required(),
        sort: Joi.string().valid(ESort.Asc, ESort.Desc).required(),
      }),
    )
    .default([]),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

export const sortQuery = (query: TQueryBy[]) => {
  const sort: Record<string, SortOrder> = {};

  for (const q of query) {
    if (q.sort) {
      sort[q.column!] = q.sort === 'asc' ? 1 : -1;
    }
  }

  // Only apply default descending sort on createdAt if the user hasn't
  // explicitly requested a sort on that column, to avoid silently overriding
  // user-specified sort directions (e.g. `createdAt: asc`).
  if (!sort.createdAt) {
    sort.createdAt = -1;
  }

  return sort;
};

/**
 * Calculates total order price from DB items + selected options, don't trust FE price.
 * @param {OrderItemInput[]} listOrder - Cart items (client payload)
 * @param {TItem[]} listItemInfo - Matching DB item records
 *
 * @returns {Promise<number>} Final total price in raw number format
 *
 * @throws {Error} If any cart item does not exist in DB
 *
 * @example
 * const total = await calculateOrderItemPrice(cart, dbItems);
 * console.log(total); // 54.90
 */
export const calculateOrderItemPrice = async (listOrder: OrderItemInput[], listItemInfo: TItem[]): Promise<number> => {
  let totalPrice = 0;

  for (const order of listOrder) {
    const itemInfo = listItemInfo.find((i) => i.itemId === order.itemId)!;

    const basePrice = itemInfo.discountPercent
      ? itemInfo.price - (itemInfo.price * itemInfo.discountPercent) / 100
      : itemInfo.price;
    const extra = order.selectedOptions ? order.selectedOptions.reduce((sum, o) => sum + (o?.extraPrice || 0), 0) : 0;
    const finalPrice = basePrice + extra;

    totalPrice += finalPrice * order.amount;
  }
  return totalPrice;
};

export const retryProcessing = async <T>(callback: () => Promise<T>, retries = 3, delay = 1500): Promise<T> => {
  try {
    return await callback();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, delay));
    return retryProcessing(callback, retries - 1, delay * 2);
  }
};

export * from './common';
export * from './config';
export * from './file';
export * from './jwt';
export * from './paypal';
export * from './rate-limit';
export * from './redis-helper';
export * from './sign-ecdsa-proof';
