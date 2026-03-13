import { TUserInfoResponse } from '@generated/graphql';
import { RedisHelper } from '@helper';
import { AuthenticationError } from '@lib';
import { TUserInfo, UserModel } from '@model';
import { RedisInstance } from './redis';

/**
 * Retrieves the authenticated user's info, preferring the Redis cache.
 * Falls back to a DB lookup and back-fills the cache on a miss.
 *
 * Uses a singleflight pattern to prevent cache stampedes: acquires a short
 * distributed lock before hitting the DB so concurrent requests for the same
 * userId don't all race to the DB simultaneously.
 *
 * This utility centralises the repeated "get-or-cache user info" pattern
 * that used to appear verbatim in every authorized resolver. Placing it in
 * the services layer (not helpers) is intentional: it depends on `@model`,
 * which is a database concern and must not live in pure utility helpers.
 *
 * @param userId - The UUID of the authenticated user (`context.user.userId`).
 * @returns Resolved user info object.
 * @throws {AuthenticationError} If the user is not found in DB (i.e. the
 *   JWT was valid but the account has been deleted).
 */
export const getOrCacheUserInfo = async (userId: string): Promise<TUserInfoResponse> => {
  // 1. Try cache first
  const cached = await RedisHelper.account.userInfoGet(userId);
  if (cached && Object.keys(cached).length > 0) {
    return cached as TUserInfoResponse;
  }

  // 2. Singleflight: acquire short lock to prevent stampede
  const lockKey = `user:cache-fill:${userId}`;
  let lockValue: string | null = null;
  try {
    lockValue = await RedisInstance.lockAcquire(lockKey, 5000); // 5s TTL
  } catch {
    // Lock acquisition failed — fall through to DB read
  }

  if (!lockValue) {
    // Another request is populating — wait briefly then retry cache
    await new Promise((resolve) => setTimeout(resolve, 150));
    const retryCache = await RedisHelper.account.userInfoGet(userId);
    if (retryCache && Object.keys(retryCache).length > 0) {
      return retryCache as TUserInfoResponse;
    }
    // Cache still empty — fall through to DB read
  }

  try {
    // 3. Fetch from DB
    const user = await UserModel.findOne({ uuid: userId }).populate<{ userInfo: TUserInfo }>('userInfo').exec();

    if (!user) {
      throw new AuthenticationError('Authorization failed');
    }

    const userInfo: TUserInfoResponse = {
      uuid: user.uuid,
      email: user.email,
      name: user.userInfo.name,
      walletAddress: user.userInfo.walletAddress,
      authMethods: user.authMethods,
      address: user.userInfo.address,
      phoneNumber: user.userInfo.phoneNumber,
    };

    // 4. Populate cache
    await RedisHelper.account.userInfoSet(userInfo);
    return userInfo;
  } finally {
    // 5. Release lock if we acquired it
    if (lockValue) {
      await RedisInstance.lockRelease(lockKey, lockValue).catch(() => {});
    }
  }
};
