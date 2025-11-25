import { EAuthMethod, ERole } from '@generated/graphql';
import { model, Schema, Types } from 'mongoose';

interface IUser {
  uuid: string;
  email: string;
  password: string;
  role: ERole;
  authMethods: EAuthMethod[];
  userInfo: Types.ObjectId;
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
    authMethods: { type: [String], enum: Object.values(EAuthMethod), required: true, default: [] },
    password: { type: String },
    userInfo: { type: Schema.Types.ObjectId, ref: 'UserInfo', required: true },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

export const UserModel = model<TUser>('User', UserSchema);
