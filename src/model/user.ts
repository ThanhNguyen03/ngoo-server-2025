import { ERole } from '@/generated/graphql';
import { model, Schema, Types } from 'mongoose';

interface IUser {
  uuid: string;
  email: string;
  walletAddress?: string;
  role: ERole;
  userInfo?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date;
}

export type TUser = IUser;

const UserSchema = new Schema<TUser>(
  {
    uuid: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    role: { type: String, enum: ['USER', 'ADMIN'], default: ERole.User },
    walletAddress: { type: String, index: true, sparse: true },
    userInfo: { type: Schema.Types.ObjectId, ref: 'UserInfo' },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

UserSchema.index({ email: 1 });
UserSchema.index({ uuid: 1 });

export const UserModel = model<TUser>('User', UserSchema);
