import { GraphQLResolveInfo } from 'graphql';
import Joi, { Schema } from 'joi';
import { JwtAuthAccessTokenInstance, TJwtPayload } from './jwt.js';
import { TBigSerial } from '@/lib';
import { ESort, QueryByInput } from '@/generated/graphql';

export const USER_ERROR_PREFIX = 'IGNORABLE_ERROR';
export const JOI_ID_SCHEMA = Joi.string()
  .trim()
  .guid({
    version: ['uuidv4'],
  })
  .required();

export type TGraphQLRequest<T> = {
  data: T;
};

export const schemaPagination = (queryList: string[]) => ({
  offset: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  query: Joi.array()
    .items(
      Joi.object<QueryByInput>({
        column: Joi.string()
          .valid(...queryList)
          .required(),
        sort: Joi.string().valid(ESort.Asc, ESort.Desc).required(),
      }),
    )
    .default([]),
  limit: Joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER).default(20),
});

export enum EUserAuthenticationStatus {
  Guest,
  Unauthenticated,
  Authenticated,
}

export type TAppContext = {
  /** Default user is a guest who can access public endpoints, then depends on
   * the requirement, middleware and resolver, it can be changed to
   * unauthenticated (e.g. due to invalid token) or authenticated user. */
  user:
    | {
        readonly kind: EUserAuthenticationStatus.Guest;
        readonly token?: string;
      }
    | {
        readonly kind: EUserAuthenticationStatus.Unauthenticated;
        readonly token?: string;
        readonly reason: Error;
      }
    | {
        readonly kind: EUserAuthenticationStatus.Authenticated;
        readonly token: string;
        userId: TBigSerial;
      };
};

/** Guest user context. Note that even if the request contains access token,
 * but if the resolver doesn't require authentication, the user will still be
 * considered as guest to avoid unnecessary JWT verification and database hits.
 * For resolvers that need authentication, use [TAuthContext]. */
export type TGuestContext = TAppContext & {
  user: Extract<TAppContext['user'], { kind: EUserAuthenticationStatus.Guest }>;
};

/** Authenticated user context */
export type TAuthorizedContext = TAppContext & {
  user: Extract<TAppContext['user'], { kind: EUserAuthenticationStatus.Authenticated }>;
};

/** Optional authenticated user context */
export type TOptionalAuthContext = TAppContext & {
  user: Extract<
    TAppContext['user'],
    { kind: EUserAuthenticationStatus.Authenticated } | { kind: EUserAuthenticationStatus.Unauthenticated }
  >;
};

export type THandler<TArgs, Context, TResult> = (
  _root: any,
  _args: TArgs,
  _context: Context,
  _info: GraphQLResolveInfo,
) => Promise<TResult>;

/** Authenticate the user based on the token in the context. */
export async function authenticateUser(context: TAppContext): Promise<TOptionalAuthContext> {
  let authContext: TOptionalAuthContext;

  const createUnauthContext = (reason: Error): TOptionalAuthContext => ({
    ...context,
    user: {
      ...context.user,
      kind: EUserAuthenticationStatus.Unauthenticated,
      reason,
    },
  });

  switch (context.user.kind) {
    case EUserAuthenticationStatus.Guest: {
      if (!context.user.token) {
        authContext = createUnauthContext(new Error('Missing access token'));

        break;
      }

      let verifiedJwtPayload: TJwtPayload;

      try {
        verifiedJwtPayload = (await JwtAuthAccessTokenInstance.verifyHeader(context.user.token)).payload;
      } catch (error) {
        if (error instanceof Error) {
          authContext = createUnauthContext(error);
          break;
        } else {
          throw error;
        }
      }

      // const isRevoked = await RedisHelper.account.isUserAccessTokenRevoked(
      //   verifiedJwtPayload.id,
      //   verifiedJwtPayload.sid,
      // );
      // if (isRevoked) {
      //   authContext = createUnauthContext(new Error('Revoked access token'));

      //   break;
      // }
      authContext = createUnauthContext(new Error('Revoked access token'));

      authContext = {
        ...context,
        user: {
          kind: EUserAuthenticationStatus.Authenticated,
          token: context.user.token,
          userId: BigInt(verifiedJwtPayload.id),
        },
      };
      break;
    }
    case EUserAuthenticationStatus.Unauthenticated:
      // Safety: Typescript couldn't infer the type of context.user in switch
      // case statement but it's guaranteed to be unauthenticated here.
      // Alternatively, we can use a type guard to check the type of
      // context.user, but it could incur computational overhead.
      authContext = context as TOptionalAuthContext;
      break;
    case EUserAuthenticationStatus.Authenticated:
      // Safety: Typescript couldn't infer the type of context.user in switch
      // case statement but it's guaranteed to be authenticated here.
      // Alternatively, we can use a type guard to check the type of
      // context.user, but it could incur computational overhead.
      authContext = context as TOptionalAuthContext;
      break;
    default:
      throw new Error('Unhandled user kind');
  }

  return authContext;
}

/** Validation wrapper for resolvers, which will validate the input arguments
 * [T] against the schema. */
export function validationWrapper<TArgs, TResult>(
  resolver: THandler<TArgs, TAppContext, TResult>,
): THandler<TArgs, TAppContext, TResult>;
export function validationWrapper<TArgs, TValidatedArgs, TResult>(
  schema: Schema<TValidatedArgs>,
  resolver: THandler<TValidatedArgs, TAppContext, TResult>,
): THandler<TArgs, TAppContext, TResult>;
export function validationWrapper<TArgs, TValidatedArgs, TResult>(
  schemaOrResolver: Schema<TValidatedArgs> | THandler<TArgs, TAppContext, TResult>,
  resolverOrUndefined?: THandler<TValidatedArgs, TAppContext, TResult>,
): THandler<TArgs, TAppContext, TResult> {
  return async (root: any, args, context, info) => {
    // No schema case
    if (!resolverOrUndefined) {
      return (schemaOrResolver as THandler<TArgs, TAppContext, TResult>)(root, args, context, info);
    }

    // With schema case
    const schema = schemaOrResolver as Schema<TValidatedArgs>;
    const resolver = resolverOrUndefined;
    const { error, value } = schema.validate(args);
    if (error) {
      throw error;
    }

    // Safety: The schema validation ensures that the value is of type TValidatedArgs.
    return resolver(root, value as TValidatedArgs, context, info);
  };
}

/** Wrapper for authorized resolver, which will verify the token and check the
 * user against the database. It also validates the input arguments [T] against
 * the schema. */
export function authorizedWrapper<TArgs, TResult>(
  resolver: THandler<TArgs, TAuthorizedContext, TResult>,
): THandler<TArgs, TAppContext, TResult>;
export function authorizedWrapper<TArgs, TValidatedArgs, TResult>(
  schema: Joi.ObjectSchema<TValidatedArgs>,
  resolver: THandler<TValidatedArgs, TAuthorizedContext, TResult>,
): THandler<TArgs, TAppContext, TResult>;
export function authorizedWrapper<TArgs, TValidatedArgs, TResult>(
  schemaOrResolver: Joi.ObjectSchema<TValidatedArgs> | THandler<TArgs, TAuthorizedContext, TResult>,
  resolverOrUndefined?: THandler<TValidatedArgs, TAuthorizedContext, TResult>,
): THandler<TArgs, TAppContext, TResult> {
  return async (root: any, args, context, info) => {
    const ctx = await authenticateUser(context);
    let authContext: TAuthorizedContext;

    switch (ctx.user.kind) {
      case EUserAuthenticationStatus.Unauthenticated:
        throw ctx.user.reason;
      case EUserAuthenticationStatus.Authenticated:
        // Safety: Typescript couldn't infer the type of context.user in switch
        // case statement but it's guaranteed to be authenticated here.
        // Alternatively, we can use a type guard to check the type of
        // context.user, but it could incur computational overhead.
        authContext = ctx as TAuthorizedContext;
        break;
      default:
        throw new Error('Unhandled user kind');
    }

    // No schema case
    if (!resolverOrUndefined) {
      return (schemaOrResolver as THandler<TArgs, TAuthorizedContext, TResult>)(root, args, authContext, info);
    }

    // With schema case
    const schema = schemaOrResolver as Joi.ObjectSchema<TValidatedArgs>;
    const resolver = resolverOrUndefined;

    // Safety: The context is guaranteed to be authenticated at this point.
    return validationWrapper(schema, (_root, _args, _context, _info) =>
      resolver(_root, _args, _context as TAuthorizedContext, _info),
    )(root, args, authContext, info);
  };
}

/** Wrapper for optionally authorized resolvers, which accepts both
 * authenticated and unauthenticated user. This eagerly authenticate the user
 * if the token is present. It also validates the input arguments [T] against
 * the schema. */
export function optionalAuthWrapper<TArgs, TResult>(
  resolver: THandler<TArgs, TOptionalAuthContext, TResult>,
): THandler<TArgs, TAppContext, TResult>;
export function optionalAuthWrapper<TArgs, TValidatedArgs, TResult>(
  schema: Joi.ObjectSchema<TValidatedArgs>,
  resolver: THandler<TValidatedArgs, TOptionalAuthContext, TResult>,
): THandler<TArgs, TAppContext, TResult>;
export function optionalAuthWrapper<TArgs, TValidatedArgs, TResult>(
  schemaOrResolver: Joi.ObjectSchema<TValidatedArgs> | THandler<TArgs, TOptionalAuthContext, TResult>,
  resolverOrUndefined?: THandler<TValidatedArgs, TOptionalAuthContext, TResult>,
): THandler<TArgs, TAppContext, TResult> {
  return async (root: any, args, context, info) => {
    let optionalAuthContext = context;

    try {
      optionalAuthContext = await authenticateUser(context);
    } catch (error) {
      // Ignore unauthenticated error
    }

    // No schema case
    if (!resolverOrUndefined) {
      return (schemaOrResolver as THandler<TArgs, TOptionalAuthContext, TResult>)(
        root,
        args,
        optionalAuthContext as TOptionalAuthContext,
        info,
      );
    }

    // With schema case
    const schema = schemaOrResolver as Joi.ObjectSchema<TValidatedArgs>;
    const resolver = resolverOrUndefined;

    // Safety: The context is guaranteed to be either authenticated or guest at this point.
    return validationWrapper(schema, (_root, _args, _context, _info) =>
      resolver(_root, _args, _context as TOptionalAuthContext, _info),
    )(root, args, optionalAuthContext, info);
  };
}

/** Wrapper for public resolvers, which doesn't require authentication and will
 * validate the input arguments [T] against the schema. */
export function publicWrapper<TArgs, TResult>(
  resolver: THandler<TArgs, TGuestContext, TResult>,
): THandler<TArgs, TAppContext, TResult>;
export function publicWrapper<TArgs, TValidatedArgs, TResult>(
  schema: Joi.ObjectSchema<TValidatedArgs>,
  resolver: THandler<TValidatedArgs, TGuestContext, TResult>,
): THandler<TArgs, TAppContext, TResult>;
export function publicWrapper<TArgs, TValidatedArgs, TResult>(
  schemaOrResolver: Joi.ObjectSchema<TValidatedArgs> | THandler<TArgs, TGuestContext, TResult>,
  resolverOrUndefined?: THandler<TValidatedArgs, TGuestContext, TResult>,
): THandler<TArgs, TAppContext, TResult> {
  return async (root: any, args, context, info) => {
    // No schema case
    if (!resolverOrUndefined) {
      return (schemaOrResolver as THandler<TArgs, TGuestContext, TResult>)(root, args, context as TGuestContext, info);
    }

    // With schema case
    const schema = schemaOrResolver as Joi.ObjectSchema<TValidatedArgs>;
    const resolver = resolverOrUndefined;

    // Safety: The context is guaranteed to be guest at this point.
    return validationWrapper(schema, (_root, _args, _context, _info) =>
      resolver(_root, _args, _context as TGuestContext, _info),
    )(root, args, context, info);
  };
}

export const gql = (v: any) => v;
