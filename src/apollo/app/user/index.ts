import {
  EAuthMethod,
  ERole,
  MutationRefreshTokenArgs,
  MutationUserConnectCryptoWalletArgs,
  MutationUserLoginArgs,
  MutationUserLogoutArgs,
  MutationUserRegisterArgs,
  Resolvers,
} from '@generated/graphql';
import {
  authorizedWrapper,
  config,
  JwtAuthAccessTokenInstance,
  JwtAuthRefreshTokenInstance,
  publicWrapper,
  TGoogleTokenPayload,
} from '@helper';
import isOk, { JOI_ERC55_ADDRESS, JWTAuthentication } from '@lib';
import { TUserInfo, UserInfoModel, UserModel } from '@model';
import { hash, verify } from 'argon2';
import { randomBytes, randomUUID } from 'crypto';
import { isHexString, verifyMessage } from 'ethers';
import Joi from 'joi';
import RedisHelper from 'src/helper/redis-helper';

// const AUTH_CODE_LENGTH = 32;
// dsaChallenge is a hex string with 132 characters long = 65 * 2 + 2 (2 is for prefix `0x`)
export const DSA_SIGNATURE_BYTE_LENGTH = 65;

const JOI_PASSWPORD = Joi.string()
  .min(8)
  .max(16)
  .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9.,])[A-Za-z\d\S]{8,16}$/)
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
  password: JOI_PASSWPORD.required(),
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
      if (isHexString(value, DSA_SIGNATURE_BYTE_LENGTH)) {
        return value;
      }
      throw new Error('Signature invalid');
    }),
  address: JOI_ERC55_ADDRESS.required(),
});

export const resolverUser: Resolvers = {
  Query: {
    userInfo: authorizedWrapper(async (_root, _args, context) => {
      const { userId } = context.user;
      const userInfoCached = await RedisHelper.account.userInfoGet(userId);

      if (userInfoCached && Object.keys(userInfoCached).length > 0) {
        return {
          ...userInfoCached,
        };
      }

      const user = await UserModel.findOne({ uuid: userId }).populate<{ userInfo: TUserInfo }>('userInfo').exec();
      if (!user) {
        throw new Error('User not found');
      }

      const info = {
        uuid: user.uuid,
        email: user.email,
        name: user.userInfo.name,
        role: user.role,
        authMethod: user.authMethod!,
        address: user.userInfo.address,
        phoneNumber: user.userInfo.phoneNumber,
      };

      // Cache user info
      await RedisHelper.account.userInfoSet(user.uuid, info);

      return info;
    }),

    cryptoWalletWithNone: authorizedWrapper(async (_root, _args, context) => {
      const messageWithNonce = `Welcome to OnProver. \
        Please sign the message to connect your wallet. \
        This message will expire in 15 minutes. #${randomUUID()}`;

      // await RedisHelperUser.walletLinkingMessage(context.user.userUuid).set(messageWithNonce, {
      //   EX: MESSAGE_WITH_NONE_CACHE_TTL_IN_SECONDS,
      // });
      return messageWithNonce;
    }),
  },

  Mutation: {
    userRegister: publicWrapper(JOI_USER_REGISTER, async (_root, args) => {
      const { email, password } = args;

      const existingUser = await UserModel.findOne({ email });
      if (existingUser) {
        throw new Error('Email already registered');
      }

      const hashedPassword = await hash(password, { type: 2, salt: randomBytes(16) });
      const newUserInfo = await UserInfoModel.create({});

      const newUser = await UserModel.create({
        uuid: randomUUID(),
        email,
        password: hashedPassword,
        role: ERole.User,
        authMethod: EAuthMethod.Credential,
        userInfo: newUserInfo._id,
      });

      return await generateTokens(newUser.uuid);
    }),

    userLogin: publicWrapper(JOI_USER_LOGIN, async (_root, args) => {
      const { token, email, password } = args;
      const rid = randomUUID();

      if (token) {
        let uuid: string = '';
        let username: string = '';
        // Verify Google token
        const { payload } = await JWTAuthentication.verifyGoogleId<TGoogleTokenPayload>(token, config.GOOGLE_CLIENT_ID);
        if (!payload || !payload.email || !payload.email_verified) {
          throw new Error('Invalid Google token');
        }

        // Find
        const existingUser = await UserModel.findOne({ email: payload.email })
          .populate<{ userInfo: TUserInfo }>('userInfo')
          .exec();
        if (!existingUser) {
          // If don't have create new user
          const newUserInfo = await UserInfoModel.create({
            name: payload.name,
          });

          const newUser = await UserModel.create({
            uuid: randomUUID(),
            email: payload.email,
            role: ERole.User,
            authMethod: EAuthMethod.Google,
            userInfo: newUserInfo._id,
            lastLoginAt: new Date(),
          });

          uuid = newUser.uuid;
          username = newUserInfo.name || '';
        } else {
          // Update last login
          existingUser.lastLoginAt = new Date();
          existingUser.authMethod = EAuthMethod.Google;

          if (existingUser.userInfo && payload.name) {
            existingUser.userInfo.name = payload.name;
          }

          existingUser.save();

          uuid = existingUser.uuid;
          username = existingUser.userInfo.name || '';
        }

        const refreshToken = await JwtAuthRefreshTokenInstance.sign({
          name: username,
          uuid,
          rid,
        });

        return {
          userUuid: uuid,
          accessToken: await RedisHelper.account.userAccessTokenCreateAndAdd({
            name: username,
            uuid,
          }),
          refreshToken,
        };
      }

      if (email && password) {
        const user = await UserModel.findOne({ email }).populate<{ userInfo: TUserInfo }>('userInfo').exec();
        if (!user || !user.password) {
          throw new Error('Invalid credentials');
        }
        const isValid = await verify(user.password, password);
        if (!isValid) {
          throw new Error('Invalid credentials');
        }
        // Update last login
        user.lastLoginAt = new Date();
        user.save();

        const refreshToken = await JwtAuthRefreshTokenInstance.sign({
          name: user.userInfo.name || '',
          uuid: user.uuid,
          rid,
        });

        return {
          userUuid: user.uuid,
          accessToken: await RedisHelper.account.userAccessTokenCreateAndAdd({
            name: user.userInfo.name || '',
            uuid: user.uuid,
          }),
          refreshToken,
        };
      }

      throw new Error('Invalid credentials');
    }),

    refreshToken: authorizedWrapper(JOI_REFRESH_TOKEN, async (_root, _args) => {
      const { refreshToken } = _args;

      let payload;
      try {
        const verified = await JwtAuthRefreshTokenInstance.verify(refreshToken);
        payload = verified.payload;
      } catch (e) {
        throw new Error('Invalid refresh token');
      }

      const { uuid, rid } = payload;
      // Check rid existed in Redis
      // const exists = await RedisHelper.refreshToken.exists(uuid, rid);
      // if (!exists) throw new Error("Refresh token revoked");

      // Creat new session
      const newSid = randomUUID();
      const newRid = randomUUID();

      const newAccessToken = await JwtAuthAccessTokenInstance.sign({
        uuid,
        sid: newSid,
      });

      const newRefreshToken = await JwtAuthRefreshTokenInstance.sign({
        uuid,
        rid: newRid,
      });

      // Set new rid into Redis and del older rid
      // await RedisHelper.refreshToken.replace(uuid, rid, newRid);

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        userUuid: uuid,
      };
    }),

    userLogout: authorizedWrapper(JOI_USER_LOGOUT, async (_root, _args, context) => {
      const { logoutEverywhere } = _args;
      const token = context.user.token;

      if (!token) {
        throw new Error('Missing auth token');
      }

      if (_args.logoutEverywhere) {
        // Revoke all access token and refresh token
        return isOk(async () => {
          // RedisHelper.account.userAccessTokenRemoveAll(context.user.userId);
        });
      }

      // revoke current token
      return isOk(async () => {
        const verifiedJwtPayload = (await JwtAuthAccessTokenInstance.verifyHeader(context.user.token)).payload;
        // await RedisHelper.account.userAccessTokenRemove(context.user.userId, verifiedJwtPayload.sid);
      });
    }),

    userConnectCryptoWallet: authorizedWrapper(JOI_USER_CONNECT_CRYPTO_WALLET, async (_root, args, context) => {
      const { signature, address } = args;
      const { user } = context;

      // const redisEntry = RedisHelperUser.walletLinkingMessage(user.userUuid);
      const nonceMessage = 'await redisEntry.get()';

      if (!nonceMessage) {
        throw new Error('No nonce message found');
      }

      // Verify the signature
      const recoveredAddress = verifyMessage(nonceMessage, signature).toLowerCase();

      if (recoveredAddress !== address) {
        throw new Error('Wallet address does not match the signature');
      }

      // Remove the challenge message from Redis
      // await redisEntry.delete();

      await UserModel.updateOne({ uuid: user.userId }, { walletAddress: recoveredAddress });

      //   // Add the wallet address to the user's information in Redis
      //   await RedisHelperUser.userInfo(user.userId.toString()).hashSet({ address: recoveredAddress });
      return {
        connectCompleted: true,
        userUuid: user.userId,
        walletAddress: recoveredAddress,
      };
    }),
  },
};
