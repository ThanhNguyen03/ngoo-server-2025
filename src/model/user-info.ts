import { model, Schema } from 'mongoose';

interface IUserInfo {
  name?: string;
  address?: string;
  phoneNumber?: string;
  walletAddress?: string;
}

export type TUserInfo = IUserInfo;

const UserInfoSchema = new Schema<TUserInfo>(
  {
    name: { type: String },
    address: { type: String },
    phoneNumber: { type: String },
    walletAddress: { type: String, index: true, sparse: true },
  },
  { timestamps: true, versionKey: false },
);

export const UserInfoModel = model<TUserInfo>('UserInfo', UserInfoSchema);
