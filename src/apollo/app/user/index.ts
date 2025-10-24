import {
  MutationUserConnectCryptoWalletArgs,
  MutationUserLoginArgs,
  MutationUserLogoutArgs,
  Resolvers,
} from '@/generated/graphql';
import { authorizedWrapper, JwtAuthAccessTokenInstance, publicWrapper } from '@/helper';
import { UserModel } from '@/model';
import isOk, { JOI_ERC55_ADDRESS } from '@/utils';
import { randomUUID } from 'crypto';
import { isHexString, verifyMessage } from 'ethers';
import Joi from 'joi';

const AUTH_CODE_LENGTH = 32;
// dsaChallenge is a hex string with 132 characters long = 65 * 2 + 2 (2 is for prefix `0x`)
export const DSA_SIGNATURE_BYTE_LENGTH = 65;

// Validate token
const JOI_USER_LOGIN = Joi.object<MutationUserLoginArgs>({
  token: Joi.string().alphanum().required().trim().length(AUTH_CODE_LENGTH),
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

export const resolverUser: Resolvers = {
  Query: {
    userInfo: authorizedWrapper(async (_root, _args, context) => {
      const { userId } = context.user;

      const imUser = new UserModel();

      const user = (await imUser.find(imUser.condition.field('id').eq(context.user.userId))).unwrapOne();

      const email = user.email;
      if (!email) {
        throw new Error('Email not found');
      }

      const userInfo = {
        uuid: user.uuid,
        email,
        name: user.name,
        walletAddress: user.walletAddress,
        role: user.role,
        address: user.address,
        phoneNumber: user.phoneNumber,
      };

      // Cache user info
      // await RedisHelper.account.userInfoSet(user.id, userInfo);

      return {
        ...userInfo,
        uuid: user.uuid,
        email,
        name: user.name,
        walletAddress: user.walletAddress,
        role: user.role,
        address: user.address,
        phoneNumber: user.phoneNumber,
      };
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
      const imUser = new UserModel();
      const { token } = args;

      return {
        userUuid: 'newOrochiIdUser.uuid',
        accessToken: 'await RedisHelper.account.userAccessTokenCreateAndAdd(newOrochiIdUser)',
        refreshToken: '',
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

      return {
        connectCompleted: true,
        userUuid: user.userUuid,
        walletAddress: recoveredAddress,
      };

      // Remove the challenge message from Redis
      // await redisEntry.delete();

      // await Connector.getInstance().transaction(async (tx) => {
      //   const loginMethodExist = await imLoginMethod.default
      //     .where({ provider: EProvider.CryptoWallet, providerUserAccount: recoveredAddress })
      //     .orWhere({ provider: EProvider.CryptoWallet, userId: user.userId })
      //     .first()
      //     .transacting(tx);

      //   if (loginMethodExist) {
      //     const isLinkedToAnotherUser = loginMethodExist.userId.toString() !== user.userId.toString();

      //     throw new Error(
      //       isLinkedToAnotherUser
      //         ? `This address ${recoveredAddress} already linked to another account`
      //         : `Your account already linked to address ${loginMethodExist.providerUserAccount}`,
      //     );
      //   }

      //   await imLoginMethod.insert(
      //     [
      //       {
      //         userId: user.userId,
      //         provider: EProvider.CryptoWallet,
      //         providerUserAccount: recoveredAddress,
      //       },
      //     ],
      //     tx,
      //   );

      //   // Add the wallet address to the user's information in Redis
      //   await RedisHelperUser.userInfo(user.userId.toString()).hashSet({ address: recoveredAddress });
      // });
    }),

    userLogout: authorizedWrapper(JOI_USER_LOGOUT, async (_root: any, args: MutationUserLogoutArgs, context) => {
      if (args.logoutEverywhere) {
        // Revoke all access token and refresh token
        return isOk(async () => {
          // RedisHelper.account.userAccessTokenRemoveAll(context.user.userId);
        });
      }

      // revoke current token
      return isOk(async () => {
        const verifiedJwtPayload = (await JwtAuthAccessTokenInstance.verifyHeader(context.user.token)).payload;
        // await RedisHelperChallenge.challenge(context.user.userId.toString()).hashRemoveItem(verifiedJwtPayload.sid);
        // await RedisHelper.account.userAccessTokenRemove(context.user.userId, verifiedJwtPayload.sid);
      });
    }),
  },
};
