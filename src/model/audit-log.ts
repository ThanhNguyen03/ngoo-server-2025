import mongoose, { Schema, Document, model, Types } from 'mongoose';

export type TAuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT' | 'PAYMENT' | 'OTHER';
export type TTargetType = 'User' | 'Item' | 'Order' | 'Category' | 'Transaction' | 'System';

type TAuditDiff = {
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
};

type TAuditMetadata = {
  refId?: string;
  [key: string]: string | number | boolean | undefined;
};

export interface IAuditLog extends Document {
  user?: Types.ObjectId; // ref User
  action: TAuditAction;
  targetType: TTargetType;
  targetId?: Types.ObjectId; // ref to another model: item, order,...
  diff?: TAuditDiff;
  metadata?: TAuditMetadata;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    action: {
      type: String,
      enum: ['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'PAYMENT', 'OTHER'],
      required: true,
    },
    targetType: {
      type: String,
      enum: ['User', 'Item', 'Order', 'Category', 'Transaction', 'System'],
      required: true,
    },
    targetId: { type: Schema.Types.ObjectId, required: false },
    diff: {
      oldValue: { type: Schema.Types.Mixed },
      newValue: { type: Schema.Types.Mixed },
    },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ user: 1 });
AuditLogSchema.index({ targetType: 1, targetId: 1 });

export const AuditLogModel = mongoose.models.AuditLog || model<IAuditLog>('AuditLog', AuditLogSchema);
