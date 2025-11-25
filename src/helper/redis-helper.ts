import { TCategory, TItemResponse, TUserInfo } from '@generated/graphql';
import { JWT_EXPIRATION_TIME_SEC, JwtAuthAccessTokenInstance, TTokenPayload } from '@helper';
import { RedisHelperCategory, RedisHelperItem, RedisHelperUser } from '@service';
import assert from 'assert';
import { randomUUID } from 'crypto';

const ONE_HOUR_EXPIRATION_TIME_SEC = 60 * 60; // 1h
export const BEARER_LENGTH = 7; // 7 is length of `Bearer + space`

export const RedisHelper = {
  account: {
    /**
     * Removes a specific token from the user access token list in Redis.
     * @param userId - TBigSerial
     * @param authorizationHeader - Authorization Header
     * @returns The number of removed items, or null if an error occurs.
     */
    userAccessTokenRemove: async (userId: string, sessionId: string): Promise<number | null> => {
      return RedisHelperUser.userAccessToken(userId).setRemove(sessionId);
    },

    /**
     * Revokes all tokens for a specific user.
     */
    userAccessTokenRemoveAll: async (userId: string): Promise<number | null> => {
      return RedisHelperUser.userAccessToken(userId).delete();
    },

    /**
     * Add a new user access token into user access token list in cache
     * @param userId - TBigSerial
     * @param token - The token to be saved.
     * @returns The result of the push operation, or null if an error occurs.
     */
    userAccessTokenAdd: async (userId: string, sessionId: string): Promise<number | null> => {
      const result = await RedisHelperUser.userAccessToken(userId).setAdd(sessionId);
      await RedisHelperUser.userAccessToken(userId).expire(JWT_EXPIRATION_TIME_SEC);
      return result;
    },

    /**
     * Generates a JWT for a user and saves it in the cache.
     * @param user - The user information required to generate the JWT.
     * @returns The generated JWT token or null if an error occurs.
     */
    userAccessTokenCreateAndAdd: async (user: TTokenPayload): Promise<string> => {
      const sid = randomUUID();
      const jwtToken = await JwtAuthAccessTokenInstance.sign({
        ...user,
        uuid: user.uuid,
        sid,
      });
      const numberOfSavedToken = await RedisHelper.account.userAccessTokenAdd(user.uuid, sid);

      assert(numberOfSavedToken != null);

      return jwtToken;
    },

    /**
     * Retrieves the information of current user from Redis.
     * @param userId - The unique identifier of the user.
     * @returns The information of current user or null if it's not existed
     */
    userInfoGet: async (userId: string): Promise<TUserInfo | null> => {
      // Note: Redis returns all hash values as strings.
      // Currently, TUserInfo is defined with all fields as strings, so this function works as expected.
      return RedisHelperUser.userInfo(userId).hashGetAll();
    },

    /**
     * Sets the information of current user in Redis.
     * @param userId - The unique identifier of the user.
     * @param data - The data of user to be saved.
     * @returns The result of the set operation, or null
     */
    userInfoSet: async (userId: string, data: TUserInfo): Promise<number | null> => {
      const safeData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v ?? '']));

      const result = await RedisHelperUser.userInfo(userId).hashSet(safeData);
      await RedisHelperUser.userInfo(userId).expire(ONE_HOUR_EXPIRATION_TIME_SEC);
      return result;
    },
  },

  category: {
    /**
     * Retrieves the information about list of category from Redis.
     * @returns The information of full list of category or null if it's not existed
     */
    categoryAllListGet: async (): Promise<TCategory[] | null> => {
      const raw = await RedisHelperCategory.category('list').hashGetAll<Record<string, TCategory>>();
      return Object.values(raw);
    },

    /**
     * Sets the information about list of category into Redis.
     * @param listCategory - The list of category to be saved.
     * @returns The result of the set operation, or null
     */
    categoryAllListSet: async (listCategory: TCategory[]): Promise<void> => {
      const fullKey = RedisHelperCategory.category('list').getFullKey();
      const pipe = RedisHelperCategory.category('list').pipeline();
      pipe.del(fullKey);
      for (const category of listCategory) {
        pipe.hSet(fullKey, category.name, JSON.stringify(category));
      }
      pipe.expire(fullKey, ONE_HOUR_EXPIRATION_TIME_SEC);
      await pipe.exec();
    },

    /**
     * Gets the information of current category in Redis.
     * @param categoryName - The name of category to be saved.
     * @returns The result of the set operation, or null
     */
    categoryGet: async (categoryName: string) => {
      return await RedisHelperCategory.category('list').hashGet<TCategory>(categoryName);
    },

    /**
     * Sets the information of current category in Redis.
     * @param category - The data of category to be updated.
     * @returns The result of the set operation, or null
     */
    categorySet: async (category: TCategory) => {
      await RedisHelperCategory.category('list').hashSet(category.name, category);
      await RedisHelperCategory.category('list').expire(ONE_HOUR_EXPIRATION_TIME_SEC);
    },

    /**
     * Removes a category from the list category in Redis.
     * @param categoryName - The unique name of the category.
     * @returns The number of removed items, or null if an error occurs.
     */
    categoryDel: async (categoryName: string) => {
      await RedisHelperCategory.category('list').hashDel(categoryName);
    },
  },

  item: {
    /**
     * Retrieves the information of item by ID from Redis.
     * @param itemId - The unique identifier of the item.
     * @returns The information of current item or null if it's not existed
     */
    itemByIdGet: async (itemId: string): Promise<TItemResponse | null> => {
      // Note: Redis returns all hash values as strings.
      // Currently, TUserInfo is defined with all fields as strings, so this function works as expected.
      return await RedisHelperItem.itemById(itemId).hashGetAll();
    },

    /**
     * Sets the information of current item in Redis.
     * @param item - The data of user to be saved.
     * @returns The result of the set operation, or null
     */
    itemByIdSet: async (item: TItemResponse): Promise<number | null> => {
      const safeData = Object.fromEntries(Object.entries(item).map(([k, v]) => [k, v ?? '']));

      const result = await RedisHelperItem.itemById(item.itemId).hashSet(safeData);
      await RedisHelperItem.itemById(item.itemId).expire(ONE_HOUR_EXPIRATION_TIME_SEC);
      return result;
    },

    /**
     * Remove the information of current item in Redis.
     * @param itemId - The unique identifier of the item.
     * @returns The result of the set operation, or null
     */
    itemByIdDel: async (itemId: string) => {
      await RedisHelperItem.itemById(itemId).delete();
    },
  },
};

export default RedisHelper;
