import mongoose, { Schema, Document, model } from 'mongoose';

export type TAuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT' | 'PAYMENT' | 'OTHER';
export type TTargetType = 'User' | 'Item' | 'Order' | 'Category' | 'Transaction' | 'System';

export type TAuditDiff = {
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
};

export type TAuditMetadata = {
  refId?: string;
  [key: string]: string | number | boolean | undefined;
};

export interface IAuditLog extends Document {
  user?: string; // UUID of the acting user
  action: TAuditAction;
  targetType: TTargetType;
  targetId?: string; // UUID or business ID of the target entity
  diff?: TAuditDiff;
  metadata?: TAuditMetadata;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    user: { type: String, required: false },
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
    targetId: { type: String, required: false },
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
AuditLogSchema.index({ action: 1, createdAt: -1 }); // filtered listing by action

export const AuditLogModel = mongoose.models.AuditLog || model<IAuditLog>('AuditLog', AuditLogSchema);
