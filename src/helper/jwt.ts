import { ERole } from '@generated/graphql';
import { jose, JWTAuthentication } from '@lib';
import { TUser, TUserInfo } from '@model';
import { config } from './config';

export const ACCESS_TOKEN_EXP = config.JWT_ACCESS_TOKEN_EXP;
export const REFRESH_TOKEN_EXP = config.JWT_REFRESH_TOKEN_EXP;
export const JWT_EXPIRATION_TIME_SEC = 60 * 60 * 24 * 30; // 30 days

// SEC-011: Issuer and audience claims bind tokens to this service and their intended purpose.
// Access and refresh tokens share the same secret but differ in algorithm (HS256 vs HS384)
// and audience — this prevents cross-type token confusion attacks.
export const JWT_ISSUER = 'ngoo-server';
export const JWT_ACCESS_AUDIENCE = 'ngoo-api:access';
export const JWT_REFRESH_AUDIENCE = 'ngoo-api:refresh';

export type TTokenPayload = jose.JWTPayload & Pick<TUserInfo & TUser, 'uuid' | 'name'>;

export type TAccessTokenPayload = TTokenPayload & {
  /** Session ID to identify the user's session. This can be stored in for
   * example Redis to efficiently manage user sessions instead of storing the
   * entire JWT token. */
  sid: string;
  role: ERole;
};

export type TRefreshTokenPayload = TTokenPayload & {
  /** Refresh token ID */
  rid: string;
  role: ERole;
};

export type TGoogleTokenPayload = jose.JWTPayload &
  Pick<TUser, 'email'> & {
    email_verified: boolean;
    name: string;
    picture: string;
  };

/**
 * JWT authentication instance for access tokens (HS256, audience: ngoo-api:access).
 * Algorithm restriction and audience claim prevent refresh tokens from being accepted here.
 */
export const JwtAuthAccessTokenInstance = JWTAuthentication.getInstance<TAccessTokenPayload>(
  config.JWT_SECRET_KEY,
  'HS256',
  ACCESS_TOKEN_EXP,
  JWT_ISSUER,
  JWT_ACCESS_AUDIENCE,
);

/**
 * JWT authentication instance for refresh tokens (HS384, audience: ngoo-api:refresh).
 * Different algorithm and audience from access tokens prevent cross-type confusion.
 */
export const JwtAuthRefreshTokenInstance = JWTAuthentication.getInstance<TRefreshTokenPayload>(
  config.JWT_SECRET_KEY,
  'HS384',
  REFRESH_TOKEN_EXP,
  JWT_ISSUER,
  JWT_REFRESH_AUDIENCE,
);
