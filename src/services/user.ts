import { TUserInfoResponse } from '@generated/graphql';
import { RedisHelper } from '@helper';
import { AuthenticationError } from '@lib';
import { TUserInfo, UserModel } from '@model';

/**
 * Retrieves the authenticated user's info, preferring the Redis cache.
 * Falls back to a DB lookup and back-fills the cache on a miss.
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
  // Fast path: serve from Redis cache
  const cached = await RedisHelper.account.userInfoGet(userId);
  if (cached) {
    return cached;
  }

  // Slow path: load from DB and populate the embedded userInfo sub-document
  const user = await UserModel.findOne({ uuid: userId })
    .populate<{ userInfo: TUserInfo }>('userInfo')
    .exec();

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

  // Write-through: populate cache for subsequent requests
  await RedisHelper.account.userInfoSet(userInfo);

  return userInfo;
};
