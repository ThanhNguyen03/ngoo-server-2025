import { TUser } from '@/model';
import { jose, JWTAuthentication } from '@/lib';
import config from './config';

export const ACCESS_TOKEN_EXP = '15m';
export const REFRESH_TOKEN_EXP = '30d';

export type TAccessTokenPayload = jose.JWTPayload &
  Pick<TUser, 'uuid'> & {
    /** Session ID to identify the user's session. This can be stored in for
     * example Redis to efficiently manage user sessions instead of storing the
     * entire JWT token. */
    sid: string;
    uuid: string;
  };

export type TRefreshTokenPayload = jose.JWTPayload &
  Pick<TUser, 'uuid'> & {
    /** Refresh token ID */
    rid: string;
    uuid: string;
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

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export const verifyGoogleIdToken = async (idToken: string, clientId: string) => {
  const JWKS = jose.createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

  const { payload } = await jose.jwtVerify(idToken, JWKS, {
    issuer: 'https://accounts.google.com',
    audience: clientId,
  });

  return payload;
};
