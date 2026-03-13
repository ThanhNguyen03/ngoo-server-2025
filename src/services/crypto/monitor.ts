/**
 * On-chain event monitor for NgooPayment smart contract.
 *
 * Polls BNB Testnet for PaymentReceived events using polling (not WebSocket)
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
import { OrderModel, PaymentModel } from '@model';
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

      // Retrieve last processed block from Redis (replay on restart)
      const lastBlock = await RedisHelper.crypto.lastProcessedBlockGet();
      const fromBlock = lastBlock !== null ? lastBlock + 1 : safeBlock;

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
      // Verify the proof exists and matches
      const proof = await RedisHelper.crypto.proofGet(orderId);
      if (!proof) {
        logger.warn({ orderId }, 'Proof not found in Redis — may have expired or already processed');
      }

      // Validate payer and amount match (defense in depth)
      if (proof) {
        const proofPayer = proof.payerAddress.toLowerCase();
        const eventPayer = payer.toLowerCase();
        if (proofPayer !== eventPayer) {
          logger.error(
            { orderId, proofPayer, eventPayer },
            'Payer mismatch between proof and on-chain event — skipping',
          );
          return;
        }

        if (proof.amount !== amount.toString()) {
          logger.error(
            { orderId, proofAmount: proof.amount, eventAmount: amount.toString() },
            'Amount mismatch between proof and on-chain event — skipping',
          );
          return;
        }
      }

      // Fetch payment and verify it's still in PROCESSING state
      const payment = await PaymentModel.findOne({ orderId });
      if (!payment) {
        throw new NotFoundError(`Payment not found for order ${orderId}`);
      }

      if (payment.status !== EPaymentStatus.Processing) {
        logger.info({ orderId, status: payment.status }, 'Payment already processed, skipping');
        return;
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

      // Cleanup
      await RedisHelper.crypto.proofDel(orderId);
      await RedisHelper.order.limitProcessingDel(payment.userId);

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
  rpcUrl: config.BNB_RPC_URL ?? '',
  chainId: config.NGOO_CHAIN_ID,
  blockConfirmations: config.CRYPTO_BLOCK_CONFIRMATIONS,
  pollIntervalMs: config.CRYPTO_MONITOR_POLL_INTERVAL_MS,
});
