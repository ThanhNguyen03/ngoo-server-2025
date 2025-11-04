import {
  ERole,
  MutationRefreshTokenArgs,
  MutationUserConnectCryptoWalletArgs,
  MutationUserLoginArgs,
  MutationUserLogoutArgs,
  Resolvers,
} from '@/generated/graphql';
import {
  authorizedWrapper,
  config,
  JwtAuthAccessTokenInstance,
  JwtAuthRefreshTokenInstance,
  publicWrapper,
  verifyGoogleIdToken,
} from '@/helper';
import { TUserInfo, UserInfoModel, UserModel } from '@/model';
import isOk, { JOI_ERC55_ADDRESS } from '@/lib';
import { randomUUID } from 'crypto';
import { isHexString, verifyMessage } from 'ethers';
import Joi from 'joi';

const AUTH_CODE_LENGTH = 32;
// dsaChallenge is a hex string with 132 characters long = 65 * 2 + 2 (2 is for prefix `0x`)
export const DSA_SIGNATURE_BYTE_LENGTH = 65;

// Validate token
const JOI_USER_LOGIN = Joi.object<MutationUserLoginArgs>({
  token: Joi.string().required(),
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
const JOI_USER_LOGOUT = Joi.object<MutationUserLogoutArgs>({
  logoutEverywhere: Joi.bool().optional().default(false),
});
const JOI_REFRESH_TOKEN = Joi.object<MutationRefreshTokenArgs>({
  refreshToken: Joi.string().required(),
});

export const resolverUser: Resolvers = {
  Query: {
    userInfo: authorizedWrapper(async (_root, _args, context) => {
      const { userId } = context.user;

      const user = await UserModel.findById(userId).populate<{ userInfo: TUserInfo }>('userInfo').exec();
      if (!user) {
        throw new Error('User not found');
      }

      const info = {
        uuid: user.uuid,
        email: user.email,
        name: user.userInfo.name,
        walletAddress: user.walletAddress,
        role: user.role,
        address: user.userInfo.address,
        phoneNumber: user.userInfo.phoneNumber,
      };

      // Cache user info
      // await RedisHelper.account.userInfoSet(user.id, userInfo);

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
    userLogin: publicWrapper(JOI_USER_LOGIN, async (_root, args) => {
      const { token } = args;

      // Verify Google token
      const payload = await verifyGoogleIdToken(token, config.GOOGLE_CLIENT_ID);
      if (!payload || !payload.email) {
        throw new Error('Invalid Google token');
      }

      // Find or create user
      let user = await UserModel.findOne({ email: payload.email });
      if (!user) {
        const userInfo = await UserInfoModel.create({
          name: payload.name,
        });

        user = await UserModel.create({
          email: payload.email,
          role: ERole.User,
          userInfo: userInfo._id,
        });
      }
      const sid = randomUUID(); // session id
      const rid = randomUUID(); // redis id

      // Access Token
      const accessToken = await JwtAuthAccessTokenInstance.sign({
        uuid: user.uuid,
        sid,
      });

      // Refresh Token
      const refreshToken = await JwtAuthRefreshTokenInstance.sign({
        uuid: user.uuid,
        rid,
      });

      return {
        accessToken,
        refreshToken,
      };
    }),

    refreshToken: publicWrapper(JOI_REFRESH_TOKEN, async (_root, _args) => {
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
      };
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
  },
};
