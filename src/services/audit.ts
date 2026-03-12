import { AuditLogModel, type TAuditAction, type TTargetType } from '@model';
import { createLogger } from '@lib';

const logger = createLogger('AuditService');

type TLogAuditInput = {
  userId?: string;
  action: TAuditAction;
  targetType: TTargetType;
  targetId?: string;
  diff?: { oldValue?: Record<string, unknown>; newValue?: Record<string, unknown> };
  metadata?: Record<string, string | number | boolean | undefined>;
};

/**
 * Fire-and-forget audit log writer. Never throws — failures are logged.
 * TODO: Integrate into existing mutations (item CRUD, category CRUD, payment, auth events)
 */
export const logAudit = async (input: TLogAuditInput): Promise<void> => {
  try {
    await AuditLogModel.create({
      user: input.userId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      diff: input.diff,
      metadata: input.metadata,
    });
  } catch (err) {
    logger.error({ err, input }, 'Failed to write audit log');
  }
};
