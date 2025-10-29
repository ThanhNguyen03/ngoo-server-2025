import { TUser } from '@/model';
import { jose, JWTAuthentication } from '@/lib';
import config from './config';

export const JWT_EXPIRATION_TIME_SEC = 60 * 60 * 24 * 30; // 30 days
export const JWT_EXPIRATION_TIME_STRING = `${JWT_EXPIRATION_TIME_SEC} seconds`;

export type TJwtPayload = jose.JWTPayload &
  Pick<TUser, 'uuid' > & {
    /** Session ID to identify the user's session. This can be stored in for
     * example Redis to efficiently manage user sessions instead of storing the
     * entire JWT token. */
    sid: string;
    uuid: string;
  };

/**
 * JWT authentication instance with secret key and default algorithm HS256, 30 days expiration
 */
export const JwtAuthAccessTokenInstance = JWTAuthentication.getInstance<TJwtPayload>(
  config.JWT_SECRET_KEY,
  'HS256',
  JWT_EXPIRATION_TIME_STRING,
);
