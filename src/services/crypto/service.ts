/**
 * Crypto payment proof generation service.
 *
 * Generates server-signed ECDSA proofs that authorize a specific user to pay
 * a specific amount for a specific order on the NgooPayment smart contract.
 *
 * Proof encoding must EXACTLY match the contract's payOrder verification:
 *   keccak256(abi.encode(orderId, payer, amount, nonce, deadline, chainId))
 * where types are: ['bytes32','address','uint256','bytes32','uint256','uint256']
 */
import { config, RedisHelper } from '@helper';
import { createLogger, PaymentError } from '@lib';
import { ethers } from 'ethers';
import { formatWeiToBnb, usdToWei } from './price-oracle';
import type { ICryptoPaymentProof, ICryptoProofRedisData } from './types';

const logger = createLogger('CryptoPaymentService');

class CryptoPaymentService {
  private _signer: ethers.Wallet | null = null;

  /**
   * Lazily initialise the signer wallet from NGOO_SIGNER env var.
   * Called once on first use — avoids initialising when CRYPTO_PAYMENT_ENABLED=false.
   */
  private getSigner(): ethers.Wallet {
    if (this._signer) return this._signer;

    if (!config.NGOO_SIGNER) {
      throw new PaymentError('NGOO_SIGNER not configured');
    }

    this._signer = new ethers.Wallet(config.NGOO_SIGNER);
    return this._signer;
  }

  /**
   * Generate a server-signed payment proof for a crypto order.
   *
   * The proof contains all parameters needed by the client to call
   * `NgooPayment.payOrder()` on-chain. It is stored in Redis with a TTL
   * equal to CACHE_CRYPTO_PROOF_TTL_SEC.
   *
   * @param params.orderId         - UUID of the order
   * @param params.totalPriceUsd   - Total order price in USD (e.g. 12.50)
   * @param params.payerAddress    - Ethereum address of the user's connected wallet
   * @returns ICryptoPaymentProof with all fields needed for the on-chain call
   */
  async generatePaymentProof(params: {
    orderId: string;
    totalPriceUsd: number;
    payerAddress: string;
  }): Promise<ICryptoPaymentProof> {
    const { orderId, totalPriceUsd, payerAddress } = params;

    if (!config.NGOO_CONTRACT_ADDRESS) {
      throw new PaymentError('NGOO_CONTRACT_ADDRESS not configured');
    }

    const signer = this.getSigner();

    // 1. Convert USD to wei
    const amountWei = await usdToWei(totalPriceUsd);
    const amountDisplay = formatWeiToBnb(amountWei);

    // 2. Generate a random single-use nonce
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // 3. Set deadline = now + proof TTL
    const deadline = Math.floor(Date.now() / 1000) + config.CRYPTO_PROOF_TTL_SEC;

    // 4. Compute orderIdHash = keccak256(utf8(orderId)) — this is the bytes32 the contract uses
    const orderIdHash = ethers.keccak256(ethers.toUtf8Bytes(orderId));

    // 5. Build the message hash — MUST match contract's abi.encode call exactly
    //    Contract: keccak256(abi.encode(orderId, msg.sender, amount, nonce, deadline, block.chainid))
    //    Types:    ['bytes32', 'address', 'uint256', 'bytes32', 'uint256', 'uint256']
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
      ['bytes32', 'address', 'uint256', 'bytes32', 'uint256', 'uint256'],
      [orderIdHash, payerAddress, BigInt(amountWei), nonce, BigInt(deadline), BigInt(config.NGOO_CHAIN_ID)],
    );
    const messageHash = ethers.keccak256(encoded);

    // 6. Sign with EIP-191 prefix (equivalent to contract's toEthSignedMessageHash)
    const signature = await signer.signMessage(ethers.getBytes(messageHash));

    // 7. Build proof data for Redis (excludes signature — not needed for verification)
    const proofData: ICryptoProofRedisData = {
      orderId,
      orderIdHash,
      amount: amountWei,
      nonce,
      deadline,
      payerAddress: payerAddress.toLowerCase(),
      createdAt: Date.now(),
    };

    // 8. Store proof and reverse mapping in Redis
    await Promise.all([
      RedisHelper.crypto.proofSet(orderId, proofData),
      RedisHelper.crypto.hashToOrderIdSet(orderIdHash, orderId),
    ]);

    logger.info({ orderId, orderIdHash, deadline, amountWei }, 'Crypto payment proof generated');

    return {
      orderId,
      orderIdHash,
      amount: amountWei,
      amountDisplay,
      nonce,
      deadline,
      signature,
      contractAddress: config.NGOO_CONTRACT_ADDRESS,
      chainId: config.NGOO_CHAIN_ID,
      payerAddress: payerAddress.toLowerCase(),
    };
  }
}

export const cryptoPaymentService = new CryptoPaymentService();
