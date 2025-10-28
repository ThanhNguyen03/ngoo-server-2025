import * as jose from 'jose';

export const JWT_ALGORITHM_REQUIRED_KEY = ['EdDSA', 'ES256', 'ES256K', 'ES384', 'ES512'] as const;
export const JWT_SUPPORT_ALGORITHM = [...JWT_ALGORITHM_REQUIRED_KEY, 'HS256', 'HS384', 'HS512'] as const;
export type TJWTAlgorithm = (typeof JWT_SUPPORT_ALGORITHM)[number];

/**
 * JWT Authentication helper supporting multiple algorithms (HS / ES / EdDSA)
 */
export class JWTAuthentication<T extends jose.JWTPayload> {
  #secret: Uint8Array | jose.KeyLike;
  private static instances = new Map<string, JWTAuthentication<any>>();
  private algorithm: TJWTAlgorithm;
  private expirationTime: number | string;

  private constructor(secret: string, algorithm: TJWTAlgorithm, expirationTime?: string | number) {
    this.algorithm = algorithm;
    this.expirationTime = expirationTime ?? '1h';
    // With HS-based algorithm → serect
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
    algorithm: TJWTAlgorithm,
    expirationTime?: string | number,
  ): JWTAuthentication<T>;
  static getInstance<T extends jose.JWTPayload>(secret: string): JWTAuthentication<T>;
  static getInstance<T extends jose.JWTPayload>(secret: string, algorithm: TJWTAlgorithm): JWTAuthentication<T>;
  static getInstance<T extends jose.JWTPayload>(
    secret: string,
    algorithm: TJWTAlgorithm = 'HS256',
    expirationTime?: string,
  ): JWTAuthentication<T> {
    const key = `${algorithm}:${secret}`;
    if (!this.instances.has(key)) {
      this.instances.set(key, new JWTAuthentication(secret, algorithm, expirationTime));
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

    return await new jose.SignJWT({ ...payload, ...jwtPayload })
      .setProtectedHeader({ alg: this.algorithm, ...header })
      .setIssuedAt()
      .setExpirationTime(expirationTime)
      .sign(this.#secret);
  }

  /** Verify fromken */
  async verify(token: string): Promise<
    {
      payload: T;
    } & Pick<jose.JWTVerifyResult, 'protectedHeader'>
  > {
    const { payload, protectedHeader } = await jose.jwtVerify(token, this.#secret);
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
