/**
 * Periodic cleanup sweep for crypto payments stuck in PROCESSING.
 *
 * Crypto payments have a hard deadline (expiredAt = proof TTL, default 15 min).
 * If the user never submits the on-chain transaction — or if the event monitor
 * missed the event — the payment stays in PROCESSING indefinitely. This sweep
 * runs every 5 minutes and moves those records to FAILED so:
 *   1. The order is closed and the user is notified.
 *   2. `limitProcessingDel` unblocks the user for a fresh order attempt.
 *
 * Gated by `CRYPTO_PAYMENT_ENABLED` — started and stopped alongside the
 * `cryptoEventMonitor` in `src/index.ts`.
 */
import { EOrderStatus, EPaymentStatus } from '@generated/graphql';
import { RedisHelper } from '@helper';
import { createLogger } from '@lib';
import { OrderModel, PaymentModel } from '@model';
import mongoose from 'mongoose';

const logger = createLogger('CryptoCleanup');

// Sweep interval: 5 minutes
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

class CryptoPaymentCleanup {
  private sweepInterval: NodeJS.Timeout | null = null;

  /**
   * Start the periodic sweep. Runs immediately on start, then every 5 min.
   */
  start(): void {
    logger.info('Crypto payment cleanup sweep started');
    // Run immediately then on interval
    this.runSweep().catch((err) => logger.error({ err }, 'Initial cleanup sweep failed'));
    this.sweepInterval = setInterval(() => {
      this.runSweep().catch((err) => logger.error({ err }, 'Scheduled cleanup sweep failed'));
    }, SWEEP_INTERVAL_MS);
  }

  /**
   * Stop the periodic sweep.
   */
  stop(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    logger.info('Crypto payment cleanup sweep stopped');
  }

  /**
   * Find all PROCESSING payments past their expiredAt deadline and move them
   * to FAILED, along with their associated orders.
   */
  private async runSweep(): Promise<void> {
    const now = new Date();

    // Find expired PROCESSING payments. The compound index on { status, expiredAt }
    // makes this query efficient without a collection scan.
    const expiredPayments = await PaymentModel.find({
      status: EPaymentStatus.Processing,
      expiredAt: { $lt: now },
    }).lean();

    if (expiredPayments.length === 0) {
      logger.debug('Cleanup sweep: no expired payments found');
      return;
    }

    logger.info({ count: expiredPayments.length }, 'Cleanup sweep: found expired payments');

    for (const payment of expiredPayments) {
      await this.sweepPayment(payment.orderId, payment.userId, payment.paymentId);
    }
  }

  /**
   * Mark a single expired payment + its order as FAILED and unblock the user.
   */
  // eslint-disable-next-line class-methods-use-this
  private async sweepPayment(orderId: string, userId: string, paymentId: string): Promise<void> {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Re-check inside the transaction — the monitor may have just processed it.
        const payment = await PaymentModel.findOne({ orderId }).session(session);
        if (!payment || payment.status !== EPaymentStatus.Processing) {
          // Already processed by the monitor or another sweep — skip.
          return;
        }

        const order = await OrderModel.findOne({ orderId }).session(session);
        if (order && order.orderStatus !== EOrderStatus.Failed) {
          order.orderStatus = EOrderStatus.Failed;
          await order.save({ session });
        }

        payment.status = EPaymentStatus.Failed;
        await payment.save({ session });
      });

      logger.info({ orderId, paymentId, userId }, 'Cleanup sweep: payment marked FAILED');
    } catch (err) {
      logger.error({ err, orderId, paymentId }, 'Cleanup sweep: failed to update payment/order');
      return;
    } finally {
      session.endSession();
    }

    // Unblock user for future orders — run outside the transaction so a Redis
    // failure doesn't roll back the DB update.
    try {
      await RedisHelper.order.limitProcessingDel(userId);
    } catch (err) {
      logger.warn({ err, userId, orderId }, 'Cleanup sweep: limitProcessingDel failed (non-critical)');
    }

    // Invalidate payment + order list caches so dashboards reflect the FAILED status.
    try {
      await Promise.all([RedisHelper.payment.paymentListInvalidate(), RedisHelper.order.orderListInvalidate()]);
    } catch (err) {
      logger.warn({ err, orderId, paymentId }, 'Cleanup sweep: cache invalidation failed (non-critical)');
    }
  }
}

export const cryptoPaymentCleanup = new CryptoPaymentCleanup();
