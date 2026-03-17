/**
 * On-chain event monitor for NgooPayment smart contract.
 *
 * Polls Ethereum Sepolia for PaymentReceived events using polling (not WebSocket)
 * for reliability on free-tier RPC providers. Processes events after
 * CRYPTO_BLOCK_CONFIRMATIONS to protect against shallow reorgs.
 *
 * Stores lastProcessedBlock in Redis so monitoring resumes from the correct
 * position after server restarts. Uses distributed locks + order status checks
 * for idempotency.
 */
import { EOrderStatus, EPaymentStatus } from '@generated/graphql';
import type { TWebhookData } from '@helper';
import { config, RedisHelper } from '@helper';
import { createLogger, NotFoundError } from '@lib';
import { OrderModel, PaymentModel, UserModel } from '@model';
import { ethers } from 'ethers';
import mongoose from 'mongoose';
// Import directly from siblings to avoid circular deps via services/index.ts
import { logAudit } from '../audit';
import { emitPaymentStatus } from '../socket';
import type { ICryptoMonitorConfig } from './types';

const logger = createLogger('CryptoEventMonitor');

// Minimal ABI — only the event we care about
const NGOO_PAYMENT_ABI = [
  'event PaymentReceived(bytes32 indexed orderId, address indexed payer, uint256 amount, uint256 timestamp)',
] as const;

class CryptoEventMonitor {
  private provider: ethers.JsonRpcProvider | null = null;
  private contract: ethers.Contract | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly monitorConfig: ICryptoMonitorConfig;
  private isProcessing = false;

  constructor(monitorConfig: ICryptoMonitorConfig) {
    this.monitorConfig = monitorConfig;
  }

  /**
   * Start the event monitor. Fetches the last processed block from Redis
   * and begins polling every `pollIntervalMs`.
   */
  async start(): Promise<void> {
    this.provider = new ethers.JsonRpcProvider(this.monitorConfig.rpcUrl);
    this.contract = new ethers.Contract(this.monitorConfig.contractAddress, NGOO_PAYMENT_ABI, this.provider);

    logger.info(
      {
        contractAddress: this.monitorConfig.contractAddress,
        chainId: this.monitorConfig.chainId,
        pollIntervalMs: this.monitorConfig.pollIntervalMs,
      },
      'Crypto event monitor starting',
    );

    // Initial poll
    await this.pollNewBlocks();

    // Start interval
    this.pollInterval = setInterval(() => {
      this.pollNewBlocks().catch((err) => {
        logger.error({ err }, 'Error in crypto event monitor poll');
      });
    }, this.monitorConfig.pollIntervalMs);
  }

  /**
   * Stop the event monitor gracefully.
   */
  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.provider) {
      this.provider.destroy();
      this.provider = null;
    }
    this.contract = null;
    logger.info('Crypto event monitor stopped');
  }

  /**
   * Poll for new blocks and process any PaymentReceived events.
   * Skips if a previous poll is still in progress.
   */
  private async pollNewBlocks(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      if (!this.provider || !this.contract) return;

      const currentBlock = await this.provider.getBlockNumber();
      // Wait for confirmations before processing
      const safeBlock = currentBlock - this.monitorConfig.blockConfirmations;
      if (safeBlock < 0) return;

      // Retrieve last processed block from Redis (replay on restart).
      // Clamp: if RPC reported a lower block after a reorg, lastBlock + 1 could
      // exceed safeBlock — Math.min prevents skipping into the unconfirmed zone.
      const lastBlock = await RedisHelper.crypto.lastProcessedBlockGet();
      const fromBlock = lastBlock !== null ? Math.min(lastBlock + 1, safeBlock) : safeBlock;

      if (fromBlock > safeBlock) return;

      logger.debug({ fromBlock, toBlock: safeBlock }, 'Polling for crypto payment events');

      const events = await this.contract.queryFilter(this.contract.filters['PaymentReceived'](), fromBlock, safeBlock);

      for (const event of events) {
        if (event instanceof ethers.EventLog) {
          await this.processPaymentEvent(event).catch((err) => {
            logger.error({ err, txHash: event.transactionHash }, 'Failed to process payment event');
          });
        }
      }

      // Update last processed block
      await RedisHelper.crypto.lastProcessedBlockSet(safeBlock);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single PaymentReceived event.
   * Uses distributed lock + order status check for idempotency.
   */
  // eslint-disable-next-line class-methods-use-this
  private async processPaymentEvent(event: ethers.EventLog): Promise<void> {
    const {
      orderId: orderIdHash,
      payer,
      amount,
    } = event.args as unknown as {
      orderId: string;
      payer: string;
      amount: bigint;
      timestamp: bigint;
    };

    const txHash = event.transactionHash;
    logger.info({ orderIdHash, payer, amount: amount.toString(), txHash }, 'Processing PaymentReceived event');

    // Resolve the orderIdHash back to the original UUID orderId
    const orderId = await RedisHelper.crypto.hashToOrderIdGet(orderIdHash);
    if (!orderId) {
      logger.warn({ orderIdHash }, 'No orderId found for hash — may be from different client, skipping');
      return;
    }

    const lockKey = `crypto:payment:${orderId}`;

    await RedisHelper.lock.withLock(lockKey, config.LOCK_CRYPTO_PAYMENT_TTL_MS, async () => {
      // Fetch payment first — needed for both the idempotency check and the
      // null-proof fallback validation path below.
      const payment = await PaymentModel.findOne({ orderId });
      if (!payment) {
        throw new NotFoundError(`Payment not found for order ${orderId}`);
      }

      if (payment.status !== EPaymentStatus.Processing) {
        logger.info({ orderId, status: payment.status }, 'Payment already processed, skipping');
        return;
      }

      // Verify the proof exists and matches (defense in depth).
      const proof = await RedisHelper.crypto.proofGet(orderId);

      if (!proof) {
        // Proof TTL has expired from Redis. Two sub-cases:
        // 1. Payment itself expired → mark FAILED (user missed the deadline).
        // 2. Payment still valid → fall back to DB wallet validation.
        if (payment.expiredAt < new Date()) {
          logger.warn({ orderId }, 'Proof expired and payment past deadline — marking FAILED');
          const failSession = await mongoose.startSession();
          try {
            await failSession.withTransaction(async () => {
              const order = await OrderModel.findOne({ orderId }).session(failSession);
              if (order) {
                payment.status = EPaymentStatus.Failed;
                order.orderStatus = EOrderStatus.Failed;
                await payment.save({ session: failSession });
                await order.save({ session: failSession });
              }
            });
          } finally {
            failSession.endSession();
          }
          return;
        }

        // Payment still valid — validate the on-chain payer against the user's
        // registered wallet address. Never mark SUCCESS without at least one
        // validation source.
        const user = await UserModel.findOne({ uuid: payment.userId })
          .populate<{ userInfo: { walletAddress?: string } }>('userInfo')
          .lean();
        if (!user?.userInfo?.walletAddress || user.userInfo.walletAddress.toLowerCase() !== payer.toLowerCase()) {
          logger.error({ orderId }, 'Payer mismatch and proof unavailable — skipping event');
          return;
        }
      } else {
        // Proof found — validate payer and amount (primary validation path).
        const proofPayer = proof.payerAddress.toLowerCase();
        const eventPayer = payer.toLowerCase();
        if (proofPayer !== eventPayer) {
          logger.error(
            { orderId, proofPayer, eventPayer },
            'Payer mismatch between proof and on-chain event — skipping',
          );
          return;
        }

        // 1.2: Use BigInt comparison — string equality is fragile under JSON
        // serialisation normalisation (e.g. leading zeros, different formatting).
        if (BigInt(proof.amount) !== amount) {
          logger.error(
            { orderId, proofAmount: proof.amount, eventAmount: amount.toString() },
            'Amount mismatch between proof and on-chain event — skipping',
          );
          return;
        }
      }

      // Atomically update Order + Payment
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const order = await OrderModel.findOne({ orderId }).session(session);
          if (!order) {
            throw new NotFoundError(`Order not found: ${orderId}`);
          }

          payment.status = EPaymentStatus.Success;
          payment.txHash = txHash;
          order.orderStatus = EOrderStatus.Paid;

          await payment.save({ session });
          await order.save({ session });
        });
      } finally {
        session.endSession();
      }

      const statusData: TWebhookData = {
        status: EPaymentStatus.Success,
        userId: payment.userId,
        paymentId: payment.paymentId,
        orderId,
        cachedAt: Date.now(),
      };

      // Cache status for reconnect replay + push Socket.IO notification
      try {
        await RedisHelper.crypto.cryptoStatusSet(orderId, statusData);
        emitPaymentStatus(payment.userId, {
          orderId,
          paymentId: payment.paymentId,
          status: EPaymentStatus.Success,
        });

        // Invalidate payment + order list caches after status change
        await Promise.all([RedisHelper.payment.paymentListInvalidate(), RedisHelper.order.orderListInvalidate()]);
      } catch (err) {
        logger.warn({ err, orderId }, 'Failed to cache/emit crypto payment status (non-critical)');
      }

      // Fire-and-forget audit log
      logAudit({
        action: 'PAYMENT',
        targetType: 'Order',
        targetId: orderId,
        userId: payment.userId,
        metadata: { txHash, amount: amount.toString() },
      });

      // 3.6: Wrap each cleanup call independently so one failure doesn't block the other.
      // If proofDel throws, limitProcessingDel must still run to unblock the user.
      try {
        await RedisHelper.crypto.proofDel(orderId);
      } catch (e) {
        logger.warn({ err: e, orderId }, 'proofDel failed (non-critical)');
      }
      try {
        await RedisHelper.order.limitProcessingDel(payment.userId);
      } catch (e) {
        logger.warn({ err: e, userId: payment.userId }, 'limitProcessingDel failed (non-critical)');
      }

      logger.info({ orderId, txHash, amount: amount.toString() }, 'Crypto payment processed successfully');
    });
  }
}

/**
 * Singleton instance — initialized lazily when config.CRYPTO_PAYMENT_ENABLED is true.
 * The start() method is called in src/index.ts conditional on the feature flag.
 */
export const cryptoEventMonitor = new CryptoEventMonitor({
  contractAddress: config.NGOO_CONTRACT_ADDRESS ?? '',
  rpcUrl: config.CRYPTO_RPC_URL ?? '',
  chainId: config.NGOO_CHAIN_ID,
  blockConfirmations: config.CRYPTO_BLOCK_CONFIRMATIONS,
  pollIntervalMs: config.CRYPTO_MONITOR_POLL_INTERVAL_MS,
});
