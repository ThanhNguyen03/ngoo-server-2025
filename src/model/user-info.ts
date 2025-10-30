import { model, Schema } from 'mongoose';

interface IUserInfo {
  name?: string;
  address?: string;
  phoneNumber?: string;
}

export type TUserInfo = IUserInfo;

const UserInfoSchema = new Schema<TUserInfo>(
  {
    name: { type: String },
    address: { type: String },
    phoneNumber: { type: String },
  },
  { timestamps: true, versionKey: false },
);

export const UserInfoModel = model<TUserInfo>('UserInfo', UserInfoSchema);
