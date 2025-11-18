import { TUserInfo } from '@generated/graphql';
import { JWT_EXPIRATION_TIME_SEC, JwtAuthAccessTokenInstance, TTokenPayload } from '@helper';
import { RedisHelperUser } from '@service';
import assert from 'assert';
import { randomUUID } from 'crypto';

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
      await RedisHelperUser.userInfo(userId).expire(JWT_EXPIRATION_TIME_SEC);
      return result;
    },
  },
};

export default RedisHelper;
