import { RateLimitError } from '@lib';
import type { GraphQLResolveInfo } from 'graphql';
import type { TAuthorizedContext, TGuestContext, THandler } from './common';
import { config } from './config';
import { RedisHelper } from './redis-helper';

export type TokenBucket = {
  tokens: number;
  lastRefill: number; // timestamp in seconds
};

export type RateLimitConfig = {
  bucketSize: number; // Maximum tokens
  refillRate: number; // Tokens per second
  refillInterval: number; // Seconds between refills
};

export type TRateLimitContext = {
  rateLimit?: {
    remaining: number;
    resetIn: number;
  };
};

export const RATE_LIMIT_CONFIGS = {
  ORDER_CREATION: {
    bucketSize: config.RATE_LIMIT_ORDER_BUCKET_SIZE,
    refillRate: config.RATE_LIMIT_ORDER_REFILL_RATE,
    refillInterval: config.RATE_LIMIT_ORDER_INTERVAL_SEC,
  },
  PAYMENT_ATTEMPT: {
    bucketSize: config.RATE_LIMIT_PAYMENT_BUCKET_SIZE,
    refillRate: config.RATE_LIMIT_PAYMENT_REFILL_RATE,
    refillInterval: config.RATE_LIMIT_PAYMENT_INTERVAL_SEC,
  },
  AUTH: {
    bucketSize: config.RATE_LIMIT_AUTH_BUCKET_SIZE,
    refillRate: config.RATE_LIMIT_AUTH_REFILL_RATE,
    refillInterval: config.RATE_LIMIT_AUTH_INTERVAL_SEC,
  },
  ADMIN_MUTATION: {
    bucketSize: config.RATE_LIMIT_ADMIN_BUCKET_SIZE,
    refillRate: config.RATE_LIMIT_ADMIN_REFILL_RATE,
    refillInterval: config.RATE_LIMIT_ADMIN_INTERVAL_SEC,
  },
  PUBLIC_QUERY: {
    bucketSize: config.RATE_LIMIT_PUBLIC_QUERY_BUCKET_SIZE,
    refillRate: config.RATE_LIMIT_PUBLIC_QUERY_REFILL_RATE,
    refillInterval: config.RATE_LIMIT_PUBLIC_QUERY_INTERVAL_SEC,
  },
};

/**
 * Wrapper for applying rate limiting to authenticated resolvers.
 *
 * This wrapper MUST be used INSIDE an `authorizedWrapper` because it relies on
 * `context.user.userId` being present. It implements a token bucket algorithm
 * to limit the number of requests a user can make within a time window.
 *
 * @param config - The rate limit configuration
 * @param resolver - The resolver function to be rate limited. It receives an extended
 *                   context with `rateLimit` information (remaining tokens and reset time)
 *
 * @returns A resolver function with the same signature but without the `rateLimit` context
 *          (the rate limit info is added internally before calling the original resolver)
 *
 * @example
 * ```typescript
 * Mutation: {
 *   createOrder: authorizedWrapper(
 *     JOI_CREATE_ORDER,
 *     rateLimitWrapper('ORDER_CREATION', async (_root, { input }, context) => {
 *       // context has both:
 *       // - user: from authorizedWrapper
 *       // - rateLimit: from rateLimitWrapper (optional)
 *
 *       const { userId } = context.user;
 *       const remainingRequests = context.rateLimit?.remaining;
 *
 *       // Your business logic here
 *       return { orderId: '123' };
 *     })
 *   )
 * }
 * ```
 *
 * @throws {Error} If rate limit is exceeded, with a message indicating when to retry
 */
export function rateLimitWrapper<TArgs, TResult>(
  rateLimitConfig: RateLimitConfig,
  resolver: THandler<TArgs, TAuthorizedContext & TRateLimitContext, TResult>,
): THandler<TArgs, TAuthorizedContext, TResult> {
  return async (
    root: unknown,
    args: TArgs,
    context: TAuthorizedContext,
    info: GraphQLResolveInfo,
  ): Promise<TResult> => {
    const userId = context.user.userId;

    // Apply rate limit
    const result = await RedisHelper.rateLimit.tokenBucketConsume(`user:${userId}`, rateLimitConfig);

    if (!result.allowed) {
      const minutes = Math.ceil(result.resetIn / 60);
      throw new RateLimitError(`Rate limit exceeded. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}`);
    }

    // Add rate limit info to context
    const rateLimitContext = {
      ...context,
      rateLimit: {
        remaining: result.remaining,
        resetIn: result.resetIn,
      },
    } as TAuthorizedContext & TRateLimitContext;

    // Call original resolver with extended context
    return resolver(root, args, rateLimitContext, info);
  };
}

/**
 * IP-based rate limit wrapper for public (unauthenticated) resolvers.
 * Must be used inside a `publicWrapper` as the resolver argument.
 * The context must have `ip` set (done in the Apollo context factory).
 *
 * @param rateLimitConfig - Token bucket configuration
 * @param resolver - The resolver to rate-limit
 * @param keyPrefix - Redis key namespace (default: 'ip:public'). Use distinct
 *   prefixes to keep separate buckets per endpoint category (e.g. 'ip:auth',
 *   'ip:query') so one category's traffic cannot exhaust another's allowance.
 */
export function publicRateLimitWrapper<TArgs, TResult>(
  rateLimitConfig: RateLimitConfig,
  resolver: THandler<TArgs, TGuestContext, TResult>,
  keyPrefix = 'ip:public',
): THandler<TArgs, TGuestContext, TResult> {
  return async (root: unknown, args: TArgs, context: TGuestContext, info: GraphQLResolveInfo): Promise<TResult> => {
    const ip = context.ip ?? 'unknown';
    const result = await RedisHelper.rateLimit.tokenBucketConsume(`${keyPrefix}:${ip}`, rateLimitConfig);

    if (!result.allowed) {
      const minutes = Math.ceil(result.resetIn / 60);
      throw new RateLimitError(`Too many requests. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}`);
    }

    return resolver(root, args, context, info);
  };
}
