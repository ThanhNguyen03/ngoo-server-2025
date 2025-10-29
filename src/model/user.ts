import mongoose, { Document, model, Schema, Types } from 'mongoose';

export type TRole = 'user' | 'admin';

interface IUser extends Document {
  email: string;
  walletAddress?: string;
  role: TRole;
  userInfo?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date;
}

export type TUser = IUser;

const UserSchema = new Schema<TUser>(
  {
    email: { type: String, required: true, unique: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    walletAddress: { type: String, index: true, sparse: true },
    userInfo: { type: Schema.Types.ObjectId, ref: 'UserInfo' },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

export const UserModel = mongoose.models.User || model<TUser>('User', UserSchema);
