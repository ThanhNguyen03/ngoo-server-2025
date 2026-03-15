import {
  ERole,
  TCategory,
  TItemResponse,
  TUserInfoResponse,
  type TOrderItem,
  type TUserInfoSnapshot,
} from '@generated/graphql';
import { JWT_EXPIRATION_TIME_SEC, JwtAuthAccessTokenInstance, TTokenPayload, type TWebhookData } from '@helper';
import { RedisHelperDerive, RedisInstance } from '@service';
import assert from 'assert';
import { randomUUID } from 'crypto';
import type { ICryptoProofRedisData } from '../services/crypto/types';
import { config } from './config';
import type { RateLimitConfig, TokenBucket } from './rate-limit';

// domain helpers
export const RedisHelperUser = RedisHelperDerive<'userAccessToken' | 'userRefreshToken' | 'userInfo' | 'walletMessage'>(
  RedisInstance,
);
export const RedisHelperCategory = RedisHelperDerive<'category'>(RedisInstance);
export const RedisHelperItem = RedisHelperDerive<
  'itemBestSeller' | 'itemNewCollection' | 'itemByCategory' | 'itemById' | 'itemList'
>(RedisInstance);
export const RedisHelperSearch = RedisHelperDerive<'searchResult' | 'hotSearch'>(RedisInstance);
export const RedisHelperRecommendation = RedisHelperDerive<'userRecs' | 'anonRecs' | 'viewDedup'>(RedisInstance);
export const RedisHelperOrder = RedisHelperDerive<'createOrder' | 'orderLimit' | 'orderList'>(RedisInstance);
export const RedisHelperPayment = RedisHelperDerive<'paymentList'>(RedisInstance);
export const RedisHelperPaypal = RedisHelperDerive<'paypalOrder' | 'paypalWebhook'>(RedisInstance);
export const RedisHelperCrypto = RedisHelperDerive<
  'cryptoProof' | 'cryptoHash' | 'bnbPrice' | 'cryptoBlock' | 'cryptoStatus'
>(RedisInstance);

export const RedisHelperRateLimit = RedisHelperDerive<'tokenBucket' | 'slidingWindow'>(RedisInstance);
export const BEARER_LENGTH = 7; // 7 is length of `Bearer + space`
export const RedisHelper = {
  account: {
    isUserAccessTokenRevoked: async (userId: string, sid: string): Promise<boolean> => {
      const exists = await RedisHelperUser.userAccessToken(userId).setHas(sid);
      return !exists;
    },

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
    userAccessTokenCreateAndAdd: async (user: TTokenPayload, role?: ERole): Promise<string> => {
      const sid = randomUUID();
      const jwtToken = await JwtAuthAccessTokenInstance.sign({
        ...user,
        uuid: user.uuid,
        sid,
        role: role ?? ERole.User,
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
    userInfoGet: async (userId: string): Promise<TUserInfoResponse | null> => {
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
    userInfoSet: async (user: TUserInfoResponse): Promise<number | null> => {
      const safeData = Object.fromEntries(Object.entries(user).map(([k, v]) => [k, v ?? '']));

      const result = await RedisHelperUser.userInfo(user.uuid).hashSet(safeData);
      await RedisHelperUser.userInfo(user.uuid).expire(config.CACHE_DEFAULT_TTL_SEC);
      return result;
    },

    userInfoDel: async (userId: string) => {
      await RedisHelperUser.userInfo(userId).delete();
    },

    // --- Refresh token rotation helpers (SEC-014) ---
    // Tracks valid refresh token IDs (rid) in a Redis set, mirroring the access
    // token (sid) tracking. Consumed on use and cleared on logoutEverywhere.

    /**
     * Register a new refresh token ID so it can be validated on next use.
     * TTL is 30 days to match the refresh token JWT expiry.
     */
    userRefreshTokenAdd: async (userId: string, rid: string): Promise<void> => {
      await RedisHelperUser.userRefreshToken(userId).setAdd(rid);
      await RedisHelperUser.userRefreshToken(userId).expire(JWT_EXPIRATION_TIME_SEC);
    },

    /**
     * Check whether a refresh token ID has already been consumed or never issued.
     * Returns true when the rid is NOT in the set (i.e. revoked / unknown).
     */
    isRefreshTokenRevoked: async (userId: string, rid: string): Promise<boolean> => {
      const exists = await RedisHelperUser.userRefreshToken(userId).setHas(rid);
      return !exists;
    },

    /**
     * Consume (invalidate) a specific refresh token ID after it has been rotated.
     * The old rid must be removed before the new one is issued.
     */
    userRefreshTokenRemove: async (userId: string, rid: string): Promise<void> => {
      await RedisHelperUser.userRefreshToken(userId).setRemove(rid);
    },

    /**
     * Revoke all refresh tokens for a user — called on logoutEverywhere.
     */
    userRefreshTokenRemoveAll: async (userId: string): Promise<void> => {
      await RedisHelperUser.userRefreshToken(userId).delete();
    },

    /** Get the wallet nonce message for a user (used during wallet connection flow). */
    walletMessageGet: async (userId: string): Promise<string | null> => {
      return RedisHelperUser.walletMessage(userId).get();
    },

    /** Store a wallet nonce message with 15-minute TTL. */
    walletMessageSet: async (userId: string, message: string): Promise<void> => {
      await RedisHelperUser.walletMessage(userId).set(message, 900);
    },

    /** Delete the wallet nonce message (one-time use after verification). */
    walletMessageDel: async (userId: string): Promise<void> => {
      await RedisHelperUser.walletMessage(userId).delete();
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
      pipe.expire(fullKey, config.CACHE_DEFAULT_TTL_SEC);
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
      await RedisHelperCategory.category('list').expire(config.CACHE_DEFAULT_TTL_SEC);
    },

    /**
     * Removes a category from the list category in Redis.
     * @param categoryName - The unique name of the category.
     * @returns The number of removed items, or null if an error occurs.
     */
    categoryDel: async (categoryName: string) => {
      await RedisHelperCategory.category('list').hashDel(categoryName);
    },

    /**
     * Deletes the entire category list cache from Redis.
     */
    categoryAllListDel: async () => {
      await RedisHelperCategory.category('list').delete();
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
      await RedisHelperItem.itemById(item.itemId).expire(config.CACHE_DEFAULT_TTL_SEC);
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

    /**
     * Get a cached item list page by a composite cache key.
     * The key includes a version number, so mutations that bump the version
     * cause automatic cache misses without needing pattern-based deletion.
     */
    itemListGet: async (cacheKey: string): Promise<string | null> => {
      const version = (await RedisHelperItem.itemList('version').get()) ?? '0';
      return RedisHelperItem.itemList(`v${version}:${cacheKey}`).get();
    },

    /**
     * Cache an item list page with short TTL (default 30s).
     * The value is a JSON-stringified response object.
     */
    itemListSet: async (cacheKey: string, value: string): Promise<void> => {
      const version = (await RedisHelperItem.itemList('version').get()) ?? '0';
      await RedisHelperItem.itemList(`v${version}:${cacheKey}`).set(value, config.CACHE_ITEM_LIST_TTL_SEC);
    },

    /**
     * Invalidate all item list caches by bumping the version counter.
     * Old entries expire naturally via TTL (30s). Called after create/update/delete.
     */
    itemListInvalidate: async (): Promise<void> => {
      await RedisHelperItem.itemList('version').incre();
    },
  },

  search: {
    /** Get cached search results by composite key. */
    searchResultGet: async (cacheKey: string): Promise<string | null> => {
      return RedisHelperSearch.searchResult(cacheKey).get();
    },

    /** Cache search results with short TTL (default 15s). */
    searchResultSet: async (cacheKey: string, value: string): Promise<void> => {
      await RedisHelperSearch.searchResult(cacheKey).set(value, config.CACHE_SEARCH_RESULT_TTL_SEC);
    },

    /**
     * Increment the search frequency of a term in the hot-search sorted set.
     * Renews the 24h rolling TTL on every write so stale terms decay naturally.
     */
    hotSearchIncrement: async (term: string): Promise<void> => {
      const key = RedisHelperSearch.hotSearch('terms');
      await key.zIncrBy(1, term);
      await key.expire(86400); // rolling 24h window
    },

    /** Return top-N search terms by frequency (highest first). */
    hotSearchGetTop: async (limit: number): Promise<Array<{ term: string; score: number }>> => {
      const results = await RedisHelperSearch.hotSearch('terms').zRevRangeWithScores(0, limit - 1);
      return results.map(({ value, score }) => ({ term: value, score }));
    },
  },

  recommendation: {
    /** Get cached personalized recommendations for an authenticated user. */
    userRecsGet: async (userId: string): Promise<string | null> => {
      return RedisHelperRecommendation.userRecs(userId).get();
    },

    /** Cache personalized recommendations for a user with 5-min TTL. */
    userRecsSet: async (userId: string, value: string): Promise<void> => {
      await RedisHelperRecommendation.userRecs(userId).set(value, config.CACHE_RECOMMENDATION_TTL_SEC);
    },

    /** Invalidate a user's recommendation cache (called after PURCHASE). */
    userRecsDel: async (userId: string): Promise<void> => {
      await RedisHelperRecommendation.userRecs(userId).delete();
    },

    /** Get cached anonymous/fallback recommendations (keyed by limit to avoid cross-limit collisions). */
    anonRecsGet: async (limit: number): Promise<string | null> => {
      return RedisHelperRecommendation.anonRecs(`global:${limit}`).get();
    },

    /** Cache anonymous recommendations with 5-min TTL (keyed by limit). */
    anonRecsSet: async (limit: number, value: string): Promise<void> => {
      await RedisHelperRecommendation.anonRecs(`global:${limit}`).set(value, config.CACHE_RECOMMENDATION_TTL_SEC);
    },

    /**
     * Atomic VIEW dedup — prevents recording more than 1 VIEW per user per item per 30s.
     * Uses SET NX (set-if-not-exists) to avoid TOCTOU race conditions where two
     * concurrent requests could both pass a GET-then-SET check.
     * Returns true if this VIEW should be skipped (already tracked recently).
     */
    viewDedupCheck: async (userId: string, itemId: string): Promise<boolean> => {
      const key = RedisHelperRecommendation.viewDedup(`${userId}:${itemId}`);
      // setNX returns true if key was set (first VIEW), false if already existed (duplicate)
      const wasSet = await key.setNX('1', 30);
      return !wasSet;
    },
  },

  order: {
    orderGet: async (
      orderId: string,
    ): Promise<{
      userId: string;
      userInfoSnapshot: TUserInfoSnapshot;
      items: TOrderItem[];
      totalPrice: number;
    } | null> => {
      return await RedisHelperOrder.createOrder(`checkout-${orderId}`).hashGetAll();
    },

    orderSet: async (
      orderId: string,
      value: {
        userId: string;
        userInfoSnapshot: TUserInfoSnapshot;
        items: TOrderItem[];
        totalPrice: number;
      },
    ) => {
      const result = await RedisHelperOrder.createOrder(`checkout-${orderId}`).hashSet(value);
      await RedisHelperOrder.createOrder(`checkout-${orderId}`).expire(config.CACHE_ORDER_CHECKOUT_TTL_SEC);
      return result;
    },

    orderDel: async (orderId: string) => {
      return await RedisHelperOrder.createOrder(`checkout-${orderId}`).delete();
    },

    limitProcessingSet: async (userId: string, value: { orderId: string; paymentMethod: string; cacheTime: Date }) => {
      await RedisHelperOrder.orderLimit(userId).set(JSON.stringify(value));
      await RedisHelperOrder.orderLimit(userId).expire(config.CACHE_ORDER_LIMIT_PROCESSING_TTL_SEC);
    },

    limitProcessingGet: async (
      userId: string,
    ): Promise<{ orderId: string; paymentMethod: string; cacheTime: Date } | null> => {
      const data = await RedisHelperOrder.orderLimit(userId).get();
      return data ? (JSON.parse(data) as { orderId: string; paymentMethod: string; cacheTime: Date }) : null;
    },

    limitProcessingDel: async (userId: string) => {
      await RedisHelperOrder.orderLimit(userId).delete();
    },

    limitAttemptIncrement: async (userId: string) => {
      const attempts = await RedisHelperOrder.orderLimit(userId).incre();
      if (attempts === 1) {
        await RedisHelperOrder.orderLimit(userId).expire(config.CACHE_ORDER_LIMIT_ATTEMPT_TTL_SEC);
      }
      return attempts;
    },

    limitAttemptGet: async (userId: string) => {
      const attempts = await RedisHelperOrder.orderLimit(userId).get();
      return parseInt(attempts || '0');
    },

    /**
     * Get a cached admin order list page (version-based invalidation).
     */
    orderListGet: async (cacheKey: string): Promise<string | null> => {
      const version = (await RedisHelperOrder.orderList('version').get()) ?? '0';
      return RedisHelperOrder.orderList(`v${version}:${cacheKey}`).get();
    },

    /**
     * Cache an admin order list page with short TTL (default 30s).
     */
    orderListSet: async (cacheKey: string, value: string): Promise<void> => {
      const version = (await RedisHelperOrder.orderList('version').get()) ?? '0';
      await RedisHelperOrder.orderList(`v${version}:${cacheKey}`).set(value, config.CACHE_ORDER_LIST_TTL_SEC);
    },

    /**
     * Invalidate all order list caches by bumping the version counter.
     */
    orderListInvalidate: async (): Promise<void> => {
      await RedisHelperOrder.orderList('version').incre();
    },
  },

  payment: {
    /**
     * Get a cached payment history page (version-based invalidation).
     * Works for both per-user and admin payment history queries.
     */
    paymentListGet: async (cacheKey: string): Promise<string | null> => {
      const version = (await RedisHelperPayment.paymentList('version').get()) ?? '0';
      return RedisHelperPayment.paymentList(`v${version}:${cacheKey}`).get();
    },

    /**
     * Cache a payment history page with short TTL (default 60s).
     */
    paymentListSet: async (cacheKey: string, value: string): Promise<void> => {
      const version = (await RedisHelperPayment.paymentList('version').get()) ?? '0';
      await RedisHelperPayment.paymentList(`v${version}:${cacheKey}`).set(value, config.CACHE_PAYMENT_LIST_TTL_SEC);
    },

    /**
     * Invalidate all payment list caches by bumping the version counter.
     * Called after payment status changes (approve, capture, etc.).
     */
    paymentListInvalidate: async (): Promise<void> => {
      await RedisHelperPayment.paymentList('version').incre();
    },
  },

  paypal: {
    webhookProcessKeyGet: async (key: string) => {
      return await RedisHelperPaypal.paypalWebhook(key).get();
    },

    webhookProcessKeySet: async (key: string, value: string) => {
      return await RedisHelperPaypal.paypalWebhook(key).set(value, config.CACHE_PAYPAL_WEBHOOK_IDEMPOTENCY_TTL_SEC);
    },

    paypalStatusGet: async (orderId: string): Promise<TWebhookData | null> => {
      return await RedisHelperPaypal.paypalOrder(`status:${orderId}`).hashGetAll();
    },

    paypalStatusSet: async (orderId: string, value: TWebhookData) => {
      const result = await RedisHelperPaypal.paypalOrder(`status:${orderId}`).hashSet(value);
      await RedisHelperPaypal.paypalOrder(`status:${orderId}`).expire(config.CACHE_PAYPAL_STATUS_TTL_SEC);
      return result;
    },
  },

  crypto: {
    /**
     * Get the stored crypto payment proof for an order.
     */
    proofGet: async (orderId: string): Promise<ICryptoProofRedisData | null> => {
      return RedisHelperCrypto.cryptoProof(orderId).hashGetAll<ICryptoProofRedisData>();
    },

    /**
     * Store a crypto payment proof with TTL.
     */
    proofSet: async (orderId: string, data: ICryptoProofRedisData): Promise<void> => {
      await RedisHelperCrypto.cryptoProof(orderId).hashSet(data);
      await RedisHelperCrypto.cryptoProof(orderId).expire(config.CACHE_CRYPTO_PROOF_TTL_SEC);
    },

    /**
     * Delete a crypto payment proof (one-time use after event processing).
     */
    proofDel: async (orderId: string): Promise<void> => {
      await RedisHelperCrypto.cryptoProof(orderId).delete();
    },

    /**
     * Get the original UUID orderId from a keccak256 hash (reverse mapping).
     */
    hashToOrderIdGet: async (orderIdHash: string): Promise<string | null> => {
      return RedisHelperCrypto.cryptoHash(orderIdHash).get();
    },

    /**
     * Store the orderIdHash → orderId reverse mapping with TTL.
     */
    hashToOrderIdSet: async (orderIdHash: string, orderId: string): Promise<void> => {
      await RedisHelperCrypto.cryptoHash(orderIdHash).set(orderId, config.CACHE_CRYPTO_PROOF_TTL_SEC);
    },

    /**
     * Get the cached BNB/USD price (as decimal string, e.g. "620.5").
     */
    bnbPriceGet: async (): Promise<string | null> => {
      return RedisHelperCrypto.bnbPrice('current').get();
    },

    /**
     * Cache the BNB/USD price with TTL.
     */
    bnbPriceSet: async (price: string): Promise<void> => {
      await RedisHelperCrypto.bnbPrice('current').set(price, config.CRYPTO_PRICE_CACHE_TTL_SEC);
    },

    /**
     * Get the last-known BNB/USD price (longer 5-min TTL, used as fallback when
     * CoinGecko is unreachable and the primary cache has expired).
     */
    bnbPriceLastKnownGet: async (): Promise<string | null> => {
      return RedisHelperCrypto.bnbPrice('last-known').get();
    },

    /**
     * Store the last-known BNB/USD price with a 5-minute TTL.
     * Updated every time a fresh price is successfully fetched from CoinGecko.
     */
    bnbPriceLastKnownSet: async (price: string): Promise<void> => {
      // 300s = 5 min. Intentionally longer than the primary cache TTL (60s)
      // so it can serve as a fallback during brief CoinGecko outages.
      await RedisHelperCrypto.bnbPrice('last-known').set(price, 300);
    },

    /**
     * Get the last processed block number for the event monitor.
     */
    lastProcessedBlockGet: async (): Promise<number | null> => {
      const val = await RedisHelperCrypto.cryptoBlock('last').get();
      return val !== null ? parseInt(val, 10) : null;
    },

    /**
     * Store the last processed block number.
     */
    lastProcessedBlockSet: async (blockNumber: number): Promise<void> => {
      await RedisHelperCrypto.cryptoBlock('last').set(String(blockNumber));
    },

    /**
     * Get the cached crypto payment status for reconnect replay.
     */
    cryptoStatusGet: async (orderId: string): Promise<TWebhookData | null> => {
      return RedisHelperCrypto.cryptoStatus(orderId).hashGetAll<TWebhookData>();
    },

    /**
     * Cache the crypto payment status for reconnect replay.
     */
    cryptoStatusSet: async (orderId: string, data: TWebhookData): Promise<void> => {
      await RedisHelperCrypto.cryptoStatus(orderId).hashSet(data);
      await RedisHelperCrypto.cryptoStatus(orderId).expire(config.CACHE_PAYPAL_STATUS_TTL_SEC);
    },
  },

  lock: {
    async withLock<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
      const lockValue = await RedisInstance.lockAcquire(key, ttl);
      if (!lockValue) {
        throw new Error('Resource is locked');
      }

      try {
        return await fn();
      } finally {
        await RedisInstance.lockRelease(key, lockValue);
      }
    },

    async withRetryLock<T>(
      key: string,
      ttl: number,
      fn: () => Promise<T>,
      options?: { maxRetries?: number; retryDelay?: number },
    ): Promise<T> {
      const lockValue = await RedisInstance.lockWithRetry(key, ttl, options);

      try {
        return await fn();
      } finally {
        await RedisInstance.lockRelease(key, lockValue);
      }
    },

    async extend(key: string, value: string, ttl: number): Promise<boolean> {
      return await RedisInstance.lockExtend(key, value, ttl);
    },
  },

  rateLimit: {
    async tokenBucketGet(key: string): Promise<TokenBucket | null> {
      const data = await RedisHelperRateLimit.tokenBucket(key).get();
      return data ? JSON.parse(data) : null;
    },

    async tokenBucketSet(key: string, bucket: TokenBucket): Promise<void> {
      await RedisHelperRateLimit.tokenBucket(key).set(JSON.stringify(bucket), config.CACHE_DEFAULT_TTL_SEC);
    },

    async tokenBucketConsume(
      key: string,
      rateLimitConfig: RateLimitConfig,
    ): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
      const now = Math.floor(Date.now() / 1000);
      const bucketKey = `token-bucket:${key}`;

      const script = `
          local key = KEYS[1]
          local now = tonumber(ARGV[1])
          local bucketSize = tonumber(ARGV[2])
          local refillRate = tonumber(ARGV[3])
          local refillInterval = tonumber(ARGV[4])
          
          local bucket = redis.call('GET', key)
          
          if not bucket then
            bucket = cjson.encode({
              tokens = bucketSize - 1,
              lastRefill = now
            })
            redis.call('SET', key, bucket, 'EX', 3600)
            return cjson.encode({
              allowed = 1,
              remaining = bucketSize - 1,
              resetIn = refillInterval
            })
          end
          
          bucket = cjson.decode(bucket)
          
          local timePassed = now - bucket.lastRefill
          local refillCycles = math.floor(timePassed / refillInterval)
          local tokensToAdd = refillCycles * refillRate
          local newTokens = math.min(bucket.tokens + tokensToAdd, bucketSize)
          local lastRefill = bucket.lastRefill + (refillCycles * refillInterval)
          
          if newTokens >= 1 then
            bucket.tokens = newTokens - 1
            bucket.lastRefill = lastRefill
            
            local nextRefill = lastRefill + refillInterval
            local resetIn = math.max(0, nextRefill - now)
            
            redis.call('SET', key, cjson.encode(bucket), 'EX', 3600)
            
            return cjson.encode({
              allowed = 1,
              remaining = bucket.tokens,
              resetIn = resetIn
            })
          else
            local nextRefill = lastRefill + refillInterval
            local resetIn = math.max(0, nextRefill - now)
            
            return cjson.encode({
              allowed = 0,
              remaining = 0,
              resetIn = resetIn
            })
          end
        `;

      const result = await RedisInstance.eval(
        script,
        [bucketKey], // keys
        [
          now.toString(),
          rateLimitConfig.bucketSize.toString(),
          rateLimitConfig.refillRate.toString(),
          rateLimitConfig.refillInterval.toString(),
        ], // args
      );

      // Handle result
      let resultStr: string;
      if (Buffer.isBuffer(result)) {
        resultStr = result.toString('utf8');
      } else if (typeof result === 'string') {
        resultStr = result;
      } else {
        resultStr = JSON.stringify(result);
      }

      const parsed = JSON.parse(resultStr);
      return {
        allowed: parsed.allowed === 1,
        remaining: parsed.remaining,
        resetIn: Math.max(0, parsed.resetIn),
      };
    },

    // Reset bucket (useful for testing or manual override)
    async tokenBucketReset(key: string): Promise<void> {
      await RedisHelperRateLimit.tokenBucket(key).delete();
    },

    async slidingWindowIncrement(key: string, windowMs: number, max: number): Promise<boolean> {
      const now = Date.now();
      const windowKey = `${key}:${Math.floor(now / windowMs)}`;

      const count = await RedisHelperRateLimit.slidingWindow(windowKey).incre();
      if (count === 1) {
        await RedisHelperRateLimit.slidingWindow(windowKey).expire(Math.ceil(windowMs / 1000));
      }

      return count <= max;
    },
  },
};
