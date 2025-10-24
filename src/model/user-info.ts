import mongoose, { Document, model, Schema } from 'mongoose';

interface IUserInfo extends Document {
  user: mongoose.Types.ObjectId; // ref ngược về User
  name?: string;
  address?: string;
  phoneNumber?: string;
}

export type TUserInfo = IUserInfo;

const UserInfoSchema = new Schema<TUserInfo>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    name: { type: String },
    address: { type: String },
    phoneNumber: { type: String },
  },
  { timestamps: true, versionKey: false },
);

export const UserInfoModel = mongoose.models.UserInfo || model<TUserInfo>('UserInfo', UserInfoSchema);
