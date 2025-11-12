import { jose, JWTAuthentication } from '@lib';
import { TUser } from '@model';
import { config } from './config';

export const ACCESS_TOKEN_EXP = '60m';
export const REFRESH_TOKEN_EXP = '30d';

export type TTokenPayload = jose.JWTPayload & Pick<TUser, 'uuid'>;

export type TAccessTokenPayload = TTokenPayload & {
  /** Session ID to identify the user's session. This can be stored in for
   * example Redis to efficiently manage user sessions instead of storing the
   * entire JWT token. */
  sid: string;
};

export type TRefreshTokenPayload = TTokenPayload & {
  /** Refresh token ID */
  rid: string;
};

export type TGoogleTokenPayload = jose.JWTPayload &
  Pick<TUser, 'email'> & {
    email_verified: boolean;
    name: string;
    picture: string;
  };

/**
 * JWT authentication instance with secret key and default algorithm HS256, 30 days expiration
 */
export const JwtAuthAccessTokenInstance = JWTAuthentication.getInstance<TAccessTokenPayload>(
  config.JWT_SECRET_KEY,
  'HS256',
  ACCESS_TOKEN_EXP,
);

export const JwtAuthRefreshTokenInstance = JWTAuthentication.getInstance<TRefreshTokenPayload>(
  config.JWT_SECRET_KEY,
  'HS384',
  REFRESH_TOKEN_EXP,
);
