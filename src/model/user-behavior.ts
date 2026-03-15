// model/user-behavior.ts — Tracks user interactions with menu items for the recommendation engine.
// Events are weighted: PURCHASE (5) > ADD_TO_CART (3) > VIEW (1).
// Each document auto-expires after 90 days via the TTL index on createdAt.
import { randomUUID } from 'crypto';
import { Schema, model } from 'mongoose';

export enum EBehaviorEvent {
  VIEW = 'VIEW',
  ADD_TO_CART = 'ADD_TO_CART',
  PURCHASE = 'PURCHASE',
}

interface IUserBehavior {
  behaviorId: string;
  userId: string; // uuid from auth context
  itemId: string; // item uuid (not Mongo _id)
  categoryName: string; // denormalized for O(1) aggregation — avoids $lookup on every recommendation query
  event: EBehaviorEvent;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type TUserBehavior = IUserBehavior;

const UserBehaviorSchema = new Schema<IUserBehavior>(
  {
    behaviorId: { type: String, required: true, unique: true, default: () => randomUUID() },
    userId: { type: String, required: true },
    itemId: { type: String, required: true },
    categoryName: { type: String, required: true },
    event: { type: String, enum: Object.values(EBehaviorEvent), required: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Covers the weighted aggregation pipeline:
// $match { userId } + $group by categoryName + $sort by score
UserBehaviorSchema.index({ userId: 1, event: 1, createdAt: -1 });

// Covers deduplication lookups: "has this user already done X to item Y?"
UserBehaviorSchema.index({ userId: 1, itemId: 1, event: 1 });

// Auto-cleanup after 90 days — bounds collection size without manual purge jobs.
// MongoDB evaluates TTL indexes every 60 seconds so expiry is approximate.
UserBehaviorSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export const UserBehaviorModel = model<TUserBehavior>('UserBehavior', UserBehaviorSchema);
