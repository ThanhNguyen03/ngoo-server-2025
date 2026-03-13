import * as jose from 'jose';

export const JWT_ALGORITHM_REQUIRED_KEY = ['EdDSA', 'ES256', 'ES256K', 'ES384', 'ES512'] as const;
export const JWT_SUPPORT_ALGORITHM = [...JWT_ALGORITHM_REQUIRED_KEY, 'HS256', 'HS384', 'HS512'] as const;
export type TJWTAlgorithm = (typeof JWT_SUPPORT_ALGORITHM)[number];
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * JWT Authentication helper supporting multiple algorithms (HS / ES / EdDSA)
 */
export class JWTAuthentication<T extends jose.JWTPayload> {
  #secret: Uint8Array | jose.KeyLike;
  private static instances = new Map<string, JWTAuthentication<any>>();
  private algorithm: TJWTAlgorithm;
  private expirationTime: number | string;
  private issuer?: string;
  private audience?: string | string[];

  private constructor(
    secret: string,
    algorithm: TJWTAlgorithm,
    expirationTime?: string | number,
    issuer?: string,
    audience?: string | string[],
  ) {
    this.algorithm = algorithm;
    this.expirationTime = expirationTime ?? '1h';
    this.issuer = issuer;
    this.audience = audience;
    // With HS-based algorithm → secret
    if (algorithm.startsWith('HS')) {
      this.#secret = new TextEncoder().encode(secret);
    } else {
      // For ES / EdDSA algorithms, treat the secret as a base64url or PEM encoded key
      this.#secret = jose.base64url.decode(secret);
    }
  }

  /** Factory with singleton pattern */
  static getInstance<T extends jose.JWTPayload>(
    secret: string,
    algorithm?: TJWTAlgorithm,
    expirationTime?: string | number,
    issuer?: string,
    audience?: string | string[],
  ): JWTAuthentication<T> {
    const algorithm_ = algorithm ?? 'HS256';
    // Include issuer and audience in cache key so instances with different claims are distinct
    const audienceKey = Array.isArray(audience) ? audience.join(',') : (audience ?? '');
    const key = `${algorithm_}:${secret}:${issuer ?? ''}:${audienceKey}`;
    if (!this.instances.has(key)) {
      this.instances.set(key, new JWTAuthentication(secret, algorithm_, expirationTime, issuer, audience));
    }
    return this.instances.get(key) as JWTAuthentication<T>;
  }

  /** Sign payload to JWT string */
  async sign(
    payload: T,
    options?: { expirationTime?: string | number } & jose.JWTPayload,
    header?: jose.JWTHeaderParameters,
  ): Promise<string> {
    const { expirationTime = this.expirationTime, ...jwtPayload } = options || {};

    let builder = new jose.SignJWT({ ...payload, ...jwtPayload })
      .setProtectedHeader({ alg: this.algorithm, ...header })
      .setIssuedAt()
      .setExpirationTime(expirationTime);

    // SEC-011: Bind tokens to issuer and audience to prevent cross-service/cross-type confusion
    if (this.issuer) builder = builder.setIssuer(this.issuer);
    if (this.audience) builder = builder.setAudience(this.audience);

    return await builder.sign(this.#secret);
  }

  /** Verify token */
  async verify(token: string): Promise<
    {
      payload: T;
    } & Pick<jose.JWTVerifyResult, 'protectedHeader'>
  > {
    // SEC-010: Restrict accepted algorithm to the one configured on this instance.
    // Without this, jose accepts any HMAC variant — a refresh token (HS384) signed
    // with the same secret could pass the access token verifier (HS256).
    // SEC-011: Validate issuer and audience claims if configured.
    const { payload, protectedHeader } = await jose.jwtVerify(token, this.#secret, {
      algorithms: [this.algorithm],
      ...(this.issuer && { issuer: this.issuer }),
      ...(this.audience && { audience: this.audience }),
    });
    return { payload: payload as T, protectedHeader };
  }

  /** Verify google id */
  static async verifyGoogleId<T>(
    token: string,
    clientId: string,
  ): Promise<
    {
      payload: T;
    } & Pick<jose.JWTVerifyResult, 'protectedHeader'>
  > {
    const JWKS = jose.createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

    const { payload, protectedHeader } = await jose.jwtVerify(token, JWKS, {
      issuer: 'https://accounts.google.com',
      audience: clientId,
    });

    return { payload: payload as T, protectedHeader };
  }

  /** Verify from header Authorization: Bearer ... */
  async verifyHeader(header: string): Promise<
    {
      payload: T;
    } & Pick<jose.JWTVerifyResult, 'protectedHeader'>
  > {
    if (!header?.startsWith('Bearer ')) throw new Error('Invalid Authorization header');
    const token = header.substring(7);
    return this.verify(token);
  }
}

export default JWTAuthentication;
export { jose };
