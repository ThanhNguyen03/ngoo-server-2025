import {
  EAuditAction,
  ETargetType,
  type MutationCreateAuditLogArgs,
  type QueryGetAuditLogArgs,
  type QueryListAuditLogArgs,
  type Resolvers,
  type TAuditLog,
} from '@generated/graphql';
import { adminWrapper, rateLimitWrapper, RATE_LIMIT_CONFIGS } from '@helper';
import { NotFoundError } from '@lib';
import { AuditLogModel, type IAuditLog } from '@model';
import Joi from 'joi';

const JOI_GET_AUDIT_LOG = Joi.object<QueryGetAuditLogArgs>({
  id: Joi.string().required(),
});

const JOI_LIST_AUDIT_LOG = Joi.object<QueryListAuditLogArgs>({
  userId: Joi.string().allow(null),
  targetType: Joi.string()
    .valid(...Object.values(ETargetType))
    .allow(null),
  targetId: Joi.string().allow(null),
  action: Joi.string()
    .valid(...Object.values(EAuditAction))
    .allow(null),
  offset: Joi.number().integer().min(0).default(0),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

const JOI_CREATE_AUDIT_LOG = Joi.object<MutationCreateAuditLogArgs>({
  input: Joi.object({
    userId: Joi.string().allow(null),
    action: Joi.string()
      .valid(...Object.values(EAuditAction))
      .required(),
    targetType: Joi.string()
      .valid(...Object.values(ETargetType))
      .required(),
    targetId: Joi.string().allow(null),
    diff: Joi.object().allow(null),
    metadata: Joi.object().allow(null),
  }),
});

/** Map a Mongoose audit log document to the GraphQL TAuditLog type. */
const toAuditLogResponse = (log: IAuditLog): TAuditLog => ({
  id: (log._id as { toString(): string }).toString(),
  userId: log.user ?? null,
  action: log.action as EAuditAction,
  targetType: log.targetType as ETargetType,
  targetId: log.targetId ?? null,
  diff: log.diff ?? null,
  metadata: log.metadata ?? null,
  createdAt: log.createdAt.getTime(),
});

export const resolverAuditLog: Resolvers = {
  Query: {
    getAuditLog: adminWrapper(JOI_GET_AUDIT_LOG, async (_root, _args) => {
      const { id } = _args;
      const log = await AuditLogModel.findById(id).exec();
      if (!log) throw new NotFoundError('Audit log not found');
      return toAuditLogResponse(log);
    }),

    listAuditLog: adminWrapper(JOI_LIST_AUDIT_LOG, async (_root, _args) => {
      const { userId, targetType, targetId, action } = _args;
      // Joi defaults ensure offset and limit are always numbers after validation
      const offset = _args.offset ?? 0;
      const limit = _args.limit ?? 20;

      const filter: Record<string, unknown> = {};
      if (userId) filter.user = userId;
      if (targetType) filter.targetType = targetType;
      if (targetId) filter.targetId = targetId;
      if (action) filter.action = action;

      const [records, total] = await Promise.all([
        AuditLogModel.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean<IAuditLog[]>(),
        AuditLogModel.countDocuments(filter),
      ]);

      return {
        offset,
        limit,
        total,
        records: records.map(toAuditLogResponse),
      };
    }),
  },

  Mutation: {
    createAuditLog: adminWrapper(
      JOI_CREATE_AUDIT_LOG,
      rateLimitWrapper(RATE_LIMIT_CONFIGS.ADMIN_MUTATION, async (_root, _args) => {
        const { input } = _args;
        const log = await AuditLogModel.create({
          user: input.userId,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          diff: input.diff,
          metadata: input.metadata,
        });
        return toAuditLogResponse(log);
      }),
    ),
  },
};
