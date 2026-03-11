import type { GraphQLResolveInfo } from 'graphql';
import { RateLimitError } from '@lib';
import type { TAppContext, TAuthorizedContext, TGuestContext, THandler } from './common';
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
    bucketSize: 5,
    refillRate: 1, // 1 token per second
    refillInterval: 60, // Refill every 60 seconds
  },
  PAYMENT_ATTEMPT: {
    bucketSize: 3,
    refillRate: 1,
    refillInterval: 300, // Refill every 5 minutes
  },
  AUTH: {
    bucketSize: 10,
    refillRate: 1,
    refillInterval: 60, // 10 attempts per minute per IP
  },
} as const;

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
  config: RateLimitConfig,
  resolver: THandler<TArgs, TAuthorizedContext & TRateLimitContext, TResult>,
): THandler<TArgs, TAuthorizedContext, TResult> {
  return async (
    root: unknown, args: TArgs, context: TAuthorizedContext, info: GraphQLResolveInfo,
  ): Promise<TResult> => {
    const userId = context.user.userId;

    // Apply rate limit
    const result = await RedisHelper.rateLimit.tokenBucketConsume(`user:${userId}`, config);

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
 */
export function publicRateLimitWrapper<TArgs, TResult>(
  config: RateLimitConfig,
  resolver: THandler<TArgs, TGuestContext, TResult>,
): THandler<TArgs, TGuestContext, TResult> {
  return async (root: unknown, args: TArgs, context: TGuestContext, info: GraphQLResolveInfo): Promise<TResult> => {
    const ip = context.ip ?? 'unknown';
    const result = await RedisHelper.rateLimit.tokenBucketConsume(`ip:auth:${ip}`, config);

    if (!result.allowed) {
      const minutes = Math.ceil(result.resetIn / 60);
      throw new RateLimitError(`Too many requests. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}`);
    }

    return resolver(root, args, context, info);
  };
}
