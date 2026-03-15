/**
 * Recommendation Resolver
 *
 * Provides two operations:
 *  - `trackBehavior` (Mutation): Logs a user interaction event (VIEW/ADD_TO_CART/PURCHASE)
 *    for use in the personalized recommendation algorithm.
 *  - `recommendations` (Query): Returns 6–8 personalized items per user.
 *
 * Algorithm (authenticated users):
 *   1. Aggregate UserBehavior for the user, grouping by categoryName with weighted scoring:
 *      PURCHASE=5, ADD_TO_CART=3, VIEW=1 → top 5 preferred categories
 *   2. Exclude items the user has already purchased
 *   3. Query items in preferred categories, sorted by recency
 *   4. Backfill with hot-search or best-seller items if fewer than 6 results
 *   5. Cache per user for 5 minutes (invalidated on PURCHASE)
 *
 * Algorithm (anonymous / <3 behaviors):
 *   1. Get top-5 hot search terms (Phase 4A) → regex-match items
 *   2. Backfill with SELLER items if still fewer than 6
 *   3. Cache globally for 5 minutes
 */
import {
  EItemStatus,
  ERecommendationSource,
  MutationTrackBehaviorArgs,
  QueryRecommendationsArgs,
  Resolvers,
  TRecommendationResponse,
} from '@generated/graphql';
import {
  EUserAuthenticationStatus,
  JOI_ID_SCHEMA,
  authorizedWrapper,
  optionalAuthWrapper,
  RATE_LIMIT_CONFIGS,
  rateLimitWrapper,
  RedisHelper,
} from '@helper';
import { createLogger, NotFoundError, RateLimitError } from '@lib';
import { CategoryModel, EBehaviorEvent, ItemModel, UserBehaviorModel } from '@model';
import Joi from 'joi';
import { toItemResponse, type TItemMappable } from '../item';

const logger = createLogger('RecommendationResolver');

// ─── Joi Schemas ──────────────────────────────────────────────────────────────

const JOI_TRACK_BEHAVIOR = Joi.object<MutationTrackBehaviorArgs>({
  input: Joi.object({
    itemId: JOI_ID_SCHEMA.required(),
    event: Joi.string()
      .valid(...Object.values(EBehaviorEvent))
      .required(),
  }).required(),
});

const JOI_RECOMMENDATIONS = Joi.object<QueryRecommendationsArgs>({
  limit: Joi.number().integer().min(1).max(20).default(8),
});

// ─── Weighted scoring for recommendation algorithm ─────────────────────────────
// Higher weights surface categories the user actively buys from.
const BEHAVIOR_WEIGHTS: Record<EBehaviorEvent, number> = {
  [EBehaviorEvent.PURCHASE]: 5,
  [EBehaviorEvent.ADD_TO_CART]: 3,
  [EBehaviorEvent.VIEW]: 1,
};

/** Escape regex special characters to prevent ReDoS when building $regex from hot search terms. */
const escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── Anonymous / cold-start fallback recommendations ──────────────────────────
/**
 * Returns hot-search–driven or best-seller items for anonymous/new users.
 * Cached globally (per limit) for 5 min — all unauthenticated users share the same response.
 */
async function getAnonRecommendations(limit: number): Promise<TRecommendationResponse> {
  // Check global anonymous cache first (keyed by limit to avoid cross-limit collisions)
  const cached = await RedisHelper.recommendation.anonRecsGet(limit);
  if (cached) {
    return JSON.parse(cached) as TRecommendationResponse;
  }

  const itemMap = new Map<string, ReturnType<typeof toItemResponse>>();

  // Phase 1: items matching hot search terms — batched into a single $or query
  // to avoid sequential DB round-trips per term.
  const hotTerms = await RedisHelper.search.hotSearchGetTop(5);
  if (hotTerms.length > 0) {
    const regexConditions = hotTerms.map(({ term }) => ({
      name: { $regex: escapeRegex(term), $options: 'i' },
    }));

    const items = await ItemModel.find({
      $or: regexConditions,
      isDeleted: false,
    })
      .populate<{ category: { name: string } }>('category', 'name')
      .lean()
      .limit(limit);

    for (const item of items) {
      if (!itemMap.has(item.itemId)) {
        itemMap.set(item.itemId, toItemResponse(item as TItemMappable));
      }
      if (itemMap.size >= limit) break;
    }
  }

  // Phase 2: backfill with best sellers if still below target
  if (itemMap.size < limit) {
    const sellers = await ItemModel.find({
      status: { $in: [EItemStatus.Seller] },
      isDeleted: false,
    })
      .populate<{ category: { name: string } }>('category', 'name')
      .lean()
      .limit(limit - itemMap.size);

    for (const item of sellers) {
      if (!itemMap.has(item.itemId)) {
        itemMap.set(item.itemId, toItemResponse(item as TItemMappable));
      }
    }
  }

  const records = Array.from(itemMap.values()).slice(0, limit);
  const source = hotTerms.length > 0 ? ERecommendationSource.HotSearch : ERecommendationSource.BestSeller;
  const result: TRecommendationResponse = { records, source };

  // Cache the anonymous response globally for 5 min (keyed by limit)
  await RedisHelper.recommendation.anonRecsSet(limit, JSON.stringify(result));
  return result;
}

// ─── Personalized recommendations for authenticated users ─────────────────────
/**
 * Runs the weighted category aggregation pipeline, excludes purchased items,
 * then backfills if fewer than 6 results. Cached per user for 5 min.
 */
async function getPersonalizedRecommendations(userId: string, limit: number): Promise<TRecommendationResponse> {
  // Check per-user cache
  const cached = await RedisHelper.recommendation.userRecsGet(userId);
  if (cached) {
    return JSON.parse(cached) as TRecommendationResponse;
  }

  // Step 1: Aggregate user behavior → top 5 preferred categories by weighted score
  const categoryScores = await UserBehaviorModel.aggregate<{ _id: string; score: number }>([
    { $match: { userId, isDeleted: false } },
    {
      $group: {
        _id: '$categoryName',
        // $sum with a conditional expression maps each event to its weight
        score: {
          $sum: {
            $switch: {
              branches: [
                { case: { $eq: ['$event', EBehaviorEvent.PURCHASE] }, then: BEHAVIOR_WEIGHTS[EBehaviorEvent.PURCHASE] },
                {
                  case: { $eq: ['$event', EBehaviorEvent.ADD_TO_CART] },
                  then: BEHAVIOR_WEIGHTS[EBehaviorEvent.ADD_TO_CART],
                },
                { case: { $eq: ['$event', EBehaviorEvent.VIEW] }, then: BEHAVIOR_WEIGHTS[EBehaviorEvent.VIEW] },
              ],
              default: 0,
            },
          },
        },
      },
    },
    { $sort: { score: -1 } },
    { $limit: 5 },
  ]);

  // Step 2: Exclude items the user already purchased to avoid recommending them again
  const purchasedItemIds = await UserBehaviorModel.distinct('itemId', {
    userId,
    event: EBehaviorEvent.PURCHASE,
    isDeleted: false,
  });

  const topCategories = categoryScores.map((c) => c._id);
  const itemMap = new Map<string, ReturnType<typeof toItemResponse>>();

  // Step 3: Fetch items from preferred categories (newest first, exclude purchased).
  // Uses a DB-level category filter to avoid over-fetching items from irrelevant categories.
  if (topCategories.length > 0) {
    // Resolve category names → ObjectIds for efficient DB filtering
    const categories = await CategoryModel.find({
      name: { $in: topCategories },
      isDeleted: false,
    })
      .select('_id')
      .lean();
    const categoryIds = categories.map((c) => c._id);

    if (categoryIds.length > 0) {
      const personalizedItems = await ItemModel.find({
        isDeleted: false,
        category: { $in: categoryIds },
        itemId: { $nin: purchasedItemIds },
      })
        .populate<{ category: { name: string } }>('category', 'name')
        .lean()
        .sort({ createdAt: -1 })
        .limit(limit);

      for (const item of personalizedItems) {
        if (!itemMap.has(item.itemId)) {
          itemMap.set(item.itemId, toItemResponse(item as TItemMappable));
        }
        if (itemMap.size >= limit) break;
      }
    }
  }

  // Step 4: Backfill with anonymous recommendations if too few personalized results
  if (itemMap.size < 6) {
    const fallback = await getAnonRecommendations(limit - itemMap.size);
    for (const rec of fallback.records) {
      if (!itemMap.has(rec.itemId)) {
        itemMap.set(rec.itemId, rec as ReturnType<typeof toItemResponse>);
      }
      if (itemMap.size >= limit) break;
    }
  }

  const records = Array.from(itemMap.values()).slice(0, limit);
  const result: TRecommendationResponse = {
    records,
    source: topCategories.length > 0 ? ERecommendationSource.Personalized : ERecommendationSource.HotSearch,
  };

  // Cache per user for 5 min
  await RedisHelper.recommendation.userRecsSet(userId, JSON.stringify(result));
  return result;
}

// ─── Resolvers ────────────────────────────────────────────────────────────────

export const resolverRecommendation: Resolvers = {
  Query: {
    /**
     * Returns personalized items for "For you" category tab.
     * - Authenticated users: weighted category preference algorithm
     * - Anonymous users: hot search terms + best sellers fallback
     * Both paths are cached in Redis for 5 min.
     */
    recommendations: optionalAuthWrapper(
      JOI_RECOMMENDATIONS,
      async (_root, args, context) => {
        // IP-based rate limiting — applies to both authenticated and anonymous users.
        // We do this manually because publicRateLimitWrapper expects TGuestContext,
        // while optionalAuthWrapper provides TOptionalAuthContext.
        const ip = context.ip ?? 'unknown';
        const rateLimitResult = await RedisHelper.rateLimit.tokenBucketConsume(
          `ip:query:${ip}`,
          RATE_LIMIT_CONFIGS.PUBLIC_QUERY,
        );
        if (!rateLimitResult.allowed) {
          const minutes = Math.ceil(rateLimitResult.resetIn / 60);
          throw new RateLimitError(`Too many requests. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}`);
        }

        const limit = (args as QueryRecommendationsArgs).limit ?? 8;

        // EUserAuthenticationStatus.Authenticated = 2
        const isAuthenticated = context.user.kind === EUserAuthenticationStatus.Authenticated;

        if (isAuthenticated && 'userId' in context.user) {
          return getPersonalizedRecommendations(context.user.userId, limit);
        }

        return getAnonRecommendations(limit);
      },
    ),
  },

  Mutation: {
    /**
     * Logs a user interaction event (VIEW or ADD_TO_CART) for the recommendation engine.
     * PURCHASE events are tracked server-side in the order resolver — cannot be spoofed.
     *
     * Security:
     *  - `authorizedWrapper` requires valid JWT
     *  - `rateLimitWrapper` caps at 30 events/min per user
     *  - VIEW events are deduped via Redis (30s TTL per user+item, atomic SET NX)
     *  - `itemId` must exist and not be deleted — prevents tracking phantom items
     */
    trackBehavior: authorizedWrapper(
      JOI_TRACK_BEHAVIOR,
      rateLimitWrapper(RATE_LIMIT_CONFIGS.BEHAVIOR_TRACKING, async (_root, args, context) => {
        const { itemId, event } = (args as MutationTrackBehaviorArgs).input;
        const userId = context.user.userId;

        // Validate item exists — prevents tracking non-existent / deleted items
        const item = await ItemModel.findOne({ itemId, isDeleted: false })
          .populate<{ category: { name: string } }>('category', 'name')
          .lean();
        if (!item) {
          throw new NotFoundError(`Item not found: ${itemId}`);
        }

        // VIEW-specific deduplication: skip if this user viewed this item in the last 30s.
        // Both the GraphQL enum value ('VIEW') and the model enum value (EBehaviorEvent.VIEW = 'VIEW')
        // are the same underlying string — we compare string values to avoid a dual-enum TS error.
        if ((event as string) === EBehaviorEvent.VIEW) {
          const isDuplicate = await RedisHelper.recommendation.viewDedupCheck(userId, itemId);
          if (isDuplicate) return true;
        }

        const populated = item as TItemMappable;

        // Fire-and-forget: never block the response for a tracking write.
        // Cast through unknown to bridge the two EBehaviorEvent enum types — they share identical string values.
        UserBehaviorModel.create({
          userId,
          itemId,
          categoryName: populated.category.name,
          event: (event as unknown) as EBehaviorEvent,
        }).catch((err) => {
          logger.error({ err, userId, itemId }, 'Failed to track behavior event');
        });

        return true;
      }),
    ),
  },
};
