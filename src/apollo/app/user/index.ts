import {
  EAuthMethod,
  ERole,
  MutationRefreshTokenArgs,
  MutationUserConnectCryptoWalletArgs,
  MutationUserLinkCredentialArgs,
  MutationUserLinkGoogleArgs,
  MutationUserLoginArgs,
  MutationUserLogoutArgs,
  MutationUserRegisterArgs,
  Resolvers,
  TUserInfoResponse,
  type MutationUserUpdateInfoArgs,
} from '@generated/graphql';
import {
  authorizedWrapper,
  config,
  JwtAuthAccessTokenInstance,
  JwtAuthRefreshTokenInstance,
  publicRateLimitWrapper,
  publicWrapper,
  RATE_LIMIT_CONFIGS,
  rateLimitWrapper,
  RedisHelper,
  TGoogleTokenPayload,
  TRefreshTokenPayload,
} from '@helper';
import isOk, { AuthenticationError, ConflictError, JOI_ERC55_ADDRESS, JWTAuthentication, NotFoundError } from '@lib';
import { TUserInfo, UserInfoModel, UserModel } from '@model';
import { logAudit } from '@service';
import { hash, verify } from 'argon2';
import { randomBytes, randomUUID } from 'crypto';
import { isHexString, verifyMessage } from 'ethers';
import Joi from 'joi';
import mongoose, { type HydratedDocument } from 'mongoose';

// const AUTH_CODE_LENGTH = 32;
// dsaChallenge is a hex string with 132 characters long = 65 * 2 + 2 (2 is for prefix `0x`)
export const DSA_SIGNATURE_BYTE_LENGTH = 65;

const JOI_PASSWORD = Joi.string()
  .min(8)
  .max(16)
  .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9.,]).{8,16}$/)
  .messages({
    'string.empty': 'Password is required',
    'string.min': 'Password must be at least 8 characters',
    'string.max': 'Password must not exceed 16 characters',
    'string.pattern.base':
      'Password must contain at least 1 uppercase, 1 lowercase, 1 number, 1 special character (except "." and ",")',
  });

// Validate token
const JOI_USER_LOGIN = Joi.object<MutationUserLoginArgs>({
  token: Joi.string().allow(null, ''),
  email: Joi.string()
    .email()
    .trim()
    .lowercase()
    .when('token', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  password: Joi.string().when('token', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
});
const JOI_USER_REGISTER = Joi.object<MutationUserRegisterArgs>({
  email: Joi.string().email().trim().lowercase().required(),
  password: JOI_PASSWORD.required(),
});
const JOI_USER_LOGOUT = Joi.object<MutationUserLogoutArgs>({
  logoutEverywhere: Joi.bool().optional().default(false),
});
const JOI_REFRESH_TOKEN = Joi.object<MutationRefreshTokenArgs>({
  refreshToken: Joi.string().required(),
});

const JOI_USER_CONNECT_CRYPTO_WALLET = Joi.object<MutationUserConnectCryptoWalletArgs>({
  signature: Joi.string()
    .trim()
    .required()
    .custom((value) => {
      if (isHexString(value, DSA_SIGNATURE_BYTE_LENGTH)) return value;
      throw new Error('Signature invalid');
    }),
  address: JOI_ERC55_ADDRESS.required(),
});

const JOI_USER_LINK_CREDENTIAL = Joi.object<MutationUserLinkCredentialArgs>({
  password: JOI_PASSWORD.required(),
});

const JOI_USER_LINK_GOOGLE = Joi.object<MutationUserLinkGoogleArgs>({
  token: Joi.string().required(),
});

const JOI_USER_UPDATE_INFO = Joi.object<MutationUserUpdateInfoArgs>({
  userInfo: Joi.object({
    name: Joi.string().min(8).max(25).messages({
      'string.min': 'Name must be at least 8 characters',
      'string.max': 'Name must not exceed 25 characters',
    }),
    phoneNumber: Joi.string()
      .trim()
      .pattern(/^[0-9]{8,15}$/)
      .min(8)
      .max(15)
      .messages({
        'string.min': 'Phone number must be at least 8 characters',
        'string.max': 'Phone number must not exceed 15 characters',
        'string.pattern.base': 'Phone number must contain only digits (8–15)',
      }),
    address: Joi.string().trim().min(8).messages({
      'string.min': 'Address must be at least 8 characters',
    }),
  }),
});

export const resolverUser: Resolvers = {
  Query: {
    userInfo: authorizedWrapper(async (_root, _args, context) => {
      const { userId, role } = context.user;
      const userInfoCached = await RedisHelper.account.userInfoGet(userId);

      if (userInfoCached && Object.keys(userInfoCached).length > 0) {
        return {
          ...userInfoCached,
        };
      }

      const user = await UserModel.findOne({ uuid: userId, role }).populate<{ userInfo: TUserInfo }>('userInfo').exec();
      if (!user) {
        throw new NotFoundError('User not found');
      }

      const info: TUserInfoResponse = {
        uuid: user.uuid,
        email: user.email,
        name: user.userInfo.name,
        authMethods: user.authMethods,
        walletAddress: user.userInfo.walletAddress,
        address: user.userInfo.address,
        phoneNumber: user.userInfo.phoneNumber,
      };

      // Cache user info
      await RedisHelper.account.userInfoSet(info);

      return info;
    }),

    cryptoWalletWithNonce: authorizedWrapper(async (_root, _args, context) => {
      const { userId } = context.user;
      const nonce = randomUUID();
      // Embed issuedAt in the signed payload so expiry is tamper-evident even if
      // Redis TTL is somehow bypassed. The verification step rejects messages
      // older than 15 minutes regardless of Redis state.
      const issuedAt = new Date().toISOString();
      const message =
        `Welcome to Ngoo. Please sign this message to connect your wallet. ` +
        `This will expire in 15 minutes. ` +
        `Nonce: ${nonce} ` +
        `Issued: ${issuedAt}`;
      await RedisHelper.account.walletMessageSet(userId, message);
      return message;
    }),
  },

  Mutation: {
    userRegister: publicWrapper(
      JOI_USER_REGISTER,
      publicRateLimitWrapper(RATE_LIMIT_CONFIGS.AUTH, async (_root, args) => {
        const { email, password } = args;

        const existingUser = await UserModel.findOne({ email });
        if (existingUser) {
          throw new ConflictError('Email already registered');
        }

        const hashedPassword = await hash(password, { type: 2, salt: randomBytes(16) });
        const userUuid = randomUUID();
        const rid = randomUUID();

        // Wrap both document creations in a transaction so an orphaned UserInfoModel
        // cannot exist if UserModel.create fails.
        type TRegisterResult = {
          newUser: typeof UserModel.prototype;
          newUserInfo: typeof UserInfoModel.prototype;
        };
        const session = await mongoose.startSession();
        const result = await session.withTransaction(async (): Promise<TRegisterResult> => {
          const [createdUserInfo] = await UserInfoModel.create([{}], { session });
          const [createdUser] = await UserModel.create(
            [
              {
                uuid: userUuid,
                email,
                password: hashedPassword,
                role: ERole.User,
                authMethods: [EAuthMethod.Credential],
                userInfo: createdUserInfo._id,
              },
            ],
            { session },
          );
          return { newUser: createdUser, newUserInfo: createdUserInfo };
        });
        session.endSession();

        const { newUser, newUserInfo } = result;

        const refreshToken = await JwtAuthRefreshTokenInstance.sign({
          name: newUserInfo.name,
          uuid: newUser.uuid,
          rid,
          role: ERole.User,
        });

        // SEC-014: Register rid so it can be validated and consumed on next rotation.
        await RedisHelper.account.userRefreshTokenAdd(newUser.uuid, rid);

        // cache userInfo
        const safeInfo: TUserInfoResponse = {
          uuid: newUser.uuid,
          email: newUser.email,
          name: newUserInfo.name,
          authMethods: newUser.authMethods,
          address: newUserInfo.address,
          phoneNumber: newUserInfo.phoneNumber,
        };
        await RedisHelper.account.userInfoSet(safeInfo);

        // Fire-and-forget audit log for new account creation
        logAudit({
          userId: newUser.uuid,
          action: 'CREATE',
          targetType: 'User',
          targetId: newUser.uuid,
          metadata: { event: 'userRegister', email },
        });

        return {
          userUuid: newUser.uuid,
          accessToken: await RedisHelper.account.userAccessTokenCreateAndAdd({
            name: newUserInfo.name,
            uuid: newUser.uuid,
          }),
          refreshToken,
        };
      }, 'ip:auth'),
    ),

    userLogin: publicWrapper(
      JOI_USER_LOGIN,
      publicRateLimitWrapper(RATE_LIMIT_CONFIGS.AUTH, async (_root, args) => {
        const { token, email, password } = args;
        const rid = randomUUID();
        let user: TUserInfoResponse = {
          uuid: '',
          name: '',
          email: '',
          walletAddress: '',
          authMethods: [EAuthMethod.Google],
          address: '',
          phoneNumber: '',
        };
        let role = ERole.User;

        if (token) {
          // Verify Google token
          const { payload } = await JWTAuthentication.verifyGoogleId<TGoogleTokenPayload>(
            token,
            config.GOOGLE_CLIENT_ID,
          );
          if (!payload || !payload.email || !payload.email_verified) {
            throw new AuthenticationError('Invalid Google token');
          }

          const nameFromGoogle = (payload.name ?? '').trim();
          // Find
          const existingUser = await UserModel.findOne({ email: payload.email })
            .populate<{ userInfo: TUserInfo }>('userInfo')
            .exec();
          if (!existingUser) {
            // Create new user — wrap in transaction to prevent orphaned UserInfoModel
            // if UserModel.create fails.
            const googleSession = await mongoose.startSession();
            const googleResult = await googleSession.withTransaction(async () => {
              const [createdUserInfo] = await UserInfoModel.create([{ name: nameFromGoogle }], {
                session: googleSession,
              });
              const [createdUser] = await UserModel.create(
                [
                  {
                    uuid: randomUUID(),
                    email: payload.email,
                    role: ERole.User,
                    authMethods: [EAuthMethod.Google],
                    userInfo: createdUserInfo._id,
                    lastLoginAt: new Date(),
                  },
                ],
                { session: googleSession },
              );
              return { newUser: createdUser, newUserInfo: createdUserInfo };
            });
            googleSession.endSession();

            user = {
              uuid: googleResult.newUser.uuid,
              email: googleResult.newUser.email,
              name: googleResult.newUserInfo.name,
              authMethods: googleResult.newUser.authMethods,
            };
            role = googleResult.newUser.role;
          } else {
            if (!existingUser.authMethods.includes(EAuthMethod.Google)) {
              existingUser.authMethods.push(EAuthMethod.Google);
            }
            // Update last login
            existingUser.lastLoginAt = new Date();

            await existingUser.save();

            user = {
              uuid: existingUser.uuid,
              email: existingUser.email,
              name: existingUser.userInfo.name,
              authMethods: existingUser.authMethods,
              walletAddress: existingUser.userInfo.walletAddress,
              address: existingUser.userInfo.address,
              phoneNumber: existingUser.userInfo.phoneNumber,
            };
            role = existingUser.role;
          }

          await RedisHelper.account.userInfoSet(user);
          const refreshToken = await JwtAuthRefreshTokenInstance.sign({
            name: user.name || '',
            uuid: user.uuid,
            rid,
            role,
          });

          // SEC-014: Register rid so it can be validated and consumed on next rotation.
          await RedisHelper.account.userRefreshTokenAdd(user.uuid, rid);

          // Fire-and-forget audit log for Google login
          logAudit({
            userId: user.uuid,
            action: 'LOGIN',
            targetType: 'User',
            targetId: user.uuid,
            metadata: { event: 'userLogin', method: 'google' },
          });

          return {
            userUuid: user.uuid,
            accessToken: await RedisHelper.account.userAccessTokenCreateAndAdd({
              name: user.name || '',
              uuid: user.uuid,
            }),
            refreshToken,
          };
        }

        if (email && password) {
          const existingUser = await UserModel.findOne({ email }).populate<{ userInfo: TUserInfo }>('userInfo').exec();
          if (!existingUser || !existingUser.password) {
            throw new AuthenticationError('Invalid email or password');
          }

          const isValid = await verify(existingUser.password, password);
          if (!isValid) {
            throw new AuthenticationError('Invalid email or password');
          }
          // Update last login
          existingUser.lastLoginAt = new Date();
          existingUser.authMethods = existingUser.authMethods || [];
          if (!existingUser.authMethods.includes(EAuthMethod.Credential)) {
            existingUser.authMethods.push(EAuthMethod.Credential);
          }
          await existingUser.save();

          const refreshToken = await JwtAuthRefreshTokenInstance.sign({
            name: existingUser.userInfo.name || '',
            uuid: existingUser.uuid,
            rid,
            role: existingUser.role,
          });

          // SEC-014: Register rid so it can be validated and consumed on next rotation.
          await RedisHelper.account.userRefreshTokenAdd(existingUser.uuid, rid);

          await RedisHelper.account.userInfoSet({
            uuid: existingUser.uuid,
            email: existingUser.email,
            name: existingUser.userInfo.name,
            authMethods: existingUser.authMethods,
            walletAddress: existingUser.userInfo.walletAddress,
            address: existingUser.userInfo.address,
            phoneNumber: existingUser.userInfo.phoneNumber,
          });

          // Fire-and-forget audit log for credential login
          logAudit({
            userId: existingUser.uuid,
            action: 'LOGIN',
            targetType: 'User',
            targetId: existingUser.uuid,
            metadata: { event: 'userLogin', method: 'credential' },
          });

          return {
            userUuid: existingUser.uuid,
            accessToken: await RedisHelper.account.userAccessTokenCreateAndAdd({
              name: existingUser.userInfo.name || '',
              uuid: existingUser.uuid,
            }),
            refreshToken,
          };
        }

        throw new AuthenticationError('Invalid credentials');
      }, 'ip:auth'),
    ),

    // FIX: Was incorrectly wrapped with `authorizedWrapper` which requires a valid
    // access token — defeating the purpose of a refresh endpoint (called when
    // the access token is expired). Changed to `publicWrapper` + IP-based rate
    // limiting to prevent brute-force attacks against the refresh token.
    refreshToken: publicWrapper(
      JOI_REFRESH_TOKEN,
      publicRateLimitWrapper(RATE_LIMIT_CONFIGS.AUTH, async (_root, _args) => {
        const { refreshToken } = _args;

        let payload: TRefreshTokenPayload;
        try {
          const verified = await JwtAuthRefreshTokenInstance.verify(refreshToken);
          payload = verified.payload;
        } catch {
          throw new AuthenticationError('Invalid refresh token');
        }

        const { uuid, role, rid } = payload;

        // Verify the user still exists in the DB before issuing new tokens.
        // JWT signature alone doesn't guarantee the account hasn't been deleted.
        const userExists = await UserModel.exists({ uuid });
        if (!userExists) {
          throw new AuthenticationError('User account no longer exists');
        }

        // SEC-014: Refresh token rotation — validate that the rid is still active in Redis.
        // If not, the token has already been rotated (or was never registered), which may
        // indicate a stolen token being reused. Reject and force re-login.
        if (rid) {
          const isRevoked = await RedisHelper.account.isRefreshTokenRevoked(uuid, rid);
          if (isRevoked) {
            // Revoke all sessions — possible token theft via reuse of a rotated-out token
            await Promise.allSettled([
              RedisHelper.account.userAccessTokenRemoveAll(uuid),
              RedisHelper.account.userRefreshTokenRemoveAll(uuid),
            ]);
            throw new AuthenticationError('Refresh token already used or revoked');
          }
          // Consume the old rid before issuing the new one (atomic rotation)
          await RedisHelper.account.userRefreshTokenRemove(uuid, rid);
        }

        // Create new session IDs for the rotated tokens
        const newSid = randomUUID();
        const newRid = randomUUID();

        const newAccessToken = await JwtAuthAccessTokenInstance.sign({
          uuid,
          sid: newSid,
          role,
        });

        const newRefreshToken = await JwtAuthRefreshTokenInstance.sign({
          uuid,
          rid: newRid,
          role,
        });

        // Register both new session IDs in Redis
        await Promise.all([
          RedisHelper.account.userAccessTokenAdd(uuid, newSid),
          RedisHelper.account.userRefreshTokenAdd(uuid, newRid),
        ]);

        return {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          userUuid: uuid,
        };
      }, 'ip:auth'),
    ),

    userLogout: authorizedWrapper(JOI_USER_LOGOUT, async (_root, _args, context) => {
      const { logoutEverywhere } = _args;
      const { userId, sid } = context.user;
      const token = context.user.token;

      if (!token) {
        throw new AuthenticationError('Missing auth token');
      }

      // Fire-and-forget audit log for logout
      logAudit({
        userId,
        action: 'LOGOUT',
        targetType: 'User',
        targetId: userId,
        metadata: { event: 'userLogout', logoutEverywhere: logoutEverywhere ?? false },
      });

      if (logoutEverywhere) {
        // Revoke all access tokens and all refresh tokens for this user (SEC-014)
        return isOk(() =>
          Promise.all([
            RedisHelper.account.userAccessTokenRemoveAll(userId),
            RedisHelper.account.userRefreshTokenRemoveAll(userId),
          ]),
        );
      }

      // FIX: `authenticateUser` (in common.ts) already decodes the JWT and sets
      // `context.user.sid`. Re-verifying the token here is redundant and wastes
      // an async round-trip. Use the sid from context directly.
      return isOk(async () => {
        await RedisHelper.account.userAccessTokenRemove(userId, sid);
      });
    }),

    userConnectCryptoWallet: authorizedWrapper(JOI_USER_CONNECT_CRYPTO_WALLET, async (_root, args, context) => {
      const { signature, address } = args;
      const { userId } = context.user;

      // 1. Get nonce message from Redis
      const nonceMessage = await RedisHelper.account.walletMessageGet(userId);
      if (!nonceMessage) {
        throw new AuthenticationError('Nonce expired or not found. Please request a new nonce.');
      }

      // 1a. Validate the embedded issuedAt timestamp (defense-in-depth: protects
      //     against replay even if Redis TTL is bypassed). Reject if >15 min old
      //     or if the timestamp is in the future (clock skew attacks).
      const issuedMatch = nonceMessage.match(/Issued: (.+)$/);
      if (issuedMatch) {
        const issuedAt = new Date(issuedMatch[1]);
        const ageMs = Date.now() - issuedAt.getTime();
        const MAX_NONCE_AGE_MS = 15 * 60 * 1000; // 15 minutes
        if (ageMs > MAX_NONCE_AGE_MS || ageMs < 0) {
          await RedisHelper.account.walletMessageDel(userId);
          throw new AuthenticationError('Nonce expired. Please request a new nonce.');
        }
      }

      // 2. Verify ECDSA signature — ethers recovers the signer address
      const recoveredAddress = verifyMessage(nonceMessage, signature);
      if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
        throw new AuthenticationError('Signature does not match the provided address');
      }

      // 3. Delete nonce (one-time use — prevents replay)
      await RedisHelper.account.walletMessageDel(userId);

      // 4. Update UserInfo.walletAddress (NOT UserModel — walletAddress lives on UserInfo)
      const user = await UserModel.findOne({ uuid: userId }).exec();
      if (!user) throw new NotFoundError('User not found');
      await UserInfoModel.findByIdAndUpdate(user.userInfo, {
        walletAddress: recoveredAddress.toLowerCase(),
      });

      // 5. Invalidate user info cache
      await RedisHelper.account.userInfoDel(userId);

      // Fire-and-forget audit log for wallet connection
      logAudit({
        userId,
        action: 'UPDATE',
        targetType: 'User',
        targetId: userId,
        metadata: { event: 'userConnectCryptoWallet', walletAddress: recoveredAddress.toLowerCase() },
      });

      return {
        connectCompleted: true,
        userUuid: userId,
        walletAddress: recoveredAddress.toLowerCase(),
      };
    }),

    /**
     * Link a password (credential auth) to an existing account.
     * Only allowed if the user does not already have CREDENTIAL in authMethods.
     * Typical use: a Google-only user wants to also log in via email/password.
     */
    userLinkCredential: authorizedWrapper(
      JOI_USER_LINK_CREDENTIAL,
      rateLimitWrapper(RATE_LIMIT_CONFIGS.AUTH, async (_root, args, context) => {
        const { userId } = context.user;
        const { password } = args;

        const user = await UserModel.findOne({ uuid: userId }).populate<{ userInfo: TUserInfo }>('userInfo').exec();
        if (!user) {
          throw new NotFoundError('User not found');
        }

        if (user.authMethods.includes(EAuthMethod.Credential)) {
          throw new ConflictError('Credential auth method is already linked');
        }

        const hashedPassword = await hash(password, { type: 2, salt: randomBytes(16) });

        user.password = hashedPassword;
        user.authMethods.push(EAuthMethod.Credential);
        await user.save();

        // Invalidate user info cache so authMethods reflect the new method
        await RedisHelper.account.userInfoDel(userId);

        logAudit({
          userId,
          action: 'UPDATE',
          targetType: 'User',
          targetId: userId,
          metadata: { event: 'userLinkCredential' },
        });

        return {
          uuid: user.uuid,
          email: user.email,
          name: user.userInfo.name,
          authMethods: user.authMethods,
          walletAddress: user.userInfo.walletAddress,
          address: user.userInfo.address,
          phoneNumber: user.userInfo.phoneNumber,
        };
      }),
    ),

    /**
     * Link a Google account to an existing credential-only account.
     * Verifies the Google token and checks that the Google email matches the
     * account email — prevents linking a Google account you don't own.
     */
    userLinkGoogle: authorizedWrapper(
      JOI_USER_LINK_GOOGLE,
      rateLimitWrapper(RATE_LIMIT_CONFIGS.AUTH, async (_root, args, context) => {
        const { userId } = context.user;
        const { token } = args;

        const user = await UserModel.findOne({ uuid: userId }).populate<{ userInfo: TUserInfo }>('userInfo').exec();
        if (!user) {
          throw new NotFoundError('User not found');
        }

        if (user.authMethods.includes(EAuthMethod.Google)) {
          throw new ConflictError('Google auth method is already linked');
        }

        // Verify Google ID token and extract email
        const { payload } = await JWTAuthentication.verifyGoogleId<TGoogleTokenPayload>(token, config.GOOGLE_CLIENT_ID);
        if (!payload || !payload.email || !payload.email_verified) {
          throw new AuthenticationError('Invalid Google token');
        }

        // The Google email must match the account email to prevent cross-account linking.
        // A user with email@example.com cannot link someone-else@example.com's Google account.
        if (payload.email.toLowerCase() !== user.email.toLowerCase()) {
          throw new AuthenticationError('Google account email does not match your account email');
        }

        user.authMethods.push(EAuthMethod.Google);
        await user.save();

        // Invalidate user info cache so authMethods reflect the new method
        await RedisHelper.account.userInfoDel(userId);

        logAudit({
          userId,
          action: 'UPDATE',
          targetType: 'User',
          targetId: userId,
          metadata: { event: 'userLinkGoogle', googleEmail: payload.email },
        });

        return {
          uuid: user.uuid,
          email: user.email,
          name: user.userInfo.name,
          authMethods: user.authMethods,
          walletAddress: user.userInfo.walletAddress,
          address: user.userInfo.address,
          phoneNumber: user.userInfo.phoneNumber,
        };
      }),
    ),

    userUpdateInfo: authorizedWrapper(JOI_USER_UPDATE_INFO, async (_root, _args, context) => {
      const { userId, role } = context.user;
      const { name, phoneNumber, address } = _args.userInfo;

      const session = await mongoose.startSession();
      try {
        const info = await session.withTransaction(async () => {
          const user = await UserModel.findOne({ uuid: userId, role })
            .populate<{ userInfo: HydratedDocument<TUserInfo> }>('userInfo')
            .session(session)
            .exec();
          if (!user) {
            throw new NotFoundError('User not found');
          }

          const userInfo = user.userInfo;

          // Only update fields that were explicitly provided in the request.
          // - `undefined` means the field was omitted → preserve existing value.
          // - `null` means the field was explicitly cleared → set to empty string.
          // - `string` → update to the new value.
          // `?? ''` narrows `string | null` → `string` to satisfy the model type.
          if (name !== undefined) userInfo.name = name ?? '';
          if (phoneNumber !== undefined) userInfo.phoneNumber = phoneNumber ?? '';
          if (address !== undefined) userInfo.address = address ?? '';

          await userInfo.save({ session });

          return {
            uuid: user.uuid,
            email: user.email,
            name: userInfo.name,
            authMethods: user.authMethods,
            walletAddress: userInfo.walletAddress,
            address: userInfo.address,
            phoneNumber: userInfo.phoneNumber,
          } as TUserInfoResponse;
        });

        // Cache outside transaction (best-effort)
        if (info) await RedisHelper.account.userInfoSet(info);

        // Fire-and-forget: do not await to avoid blocking the response
        logAudit({
          userId,
          action: 'UPDATE',
          targetType: 'User',
          targetId: userId,
        });

        return info;
      } finally {
        session.endSession();
      }
    }),
  },
};
