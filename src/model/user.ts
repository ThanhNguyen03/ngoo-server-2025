import { ERole } from '@/generated/graphql';
import { Document, model, Schema, Types } from 'mongoose';

interface IUser extends Document {
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
    email: { type: String, required: true, unique: true },
    role: { type: String, enum: ['USER', 'ADMIN'], default: ERole.User },
    walletAddress: { type: String, index: true, sparse: true },
    userInfo: { type: Schema.Types.ObjectId, ref: 'UserInfo' },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

export const UserModel = model<TUser>('User', UserSchema);
