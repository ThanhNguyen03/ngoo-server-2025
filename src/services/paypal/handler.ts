/* eslint-disable camelcase */
/**
 * PayPal webhook business logic handlers.
 *
 * These functions process incoming PayPal webhook events by persisting state
 * changes to the database and pushing real-time status updates to connected
 * clients via Socket.IO.
 *
 * Architectural note: This module lives in `services/` (not `helper/`) because
 * it depends on `@model` (database layer) and `@service` (Socket.IO transport).
 * Helpers must remain pure utilities with no model or service dependencies.
 */
import { EOrderStatus, EPaymentMethod, EPaymentStatus } from '@generated/graphql';
import {
  config,
  getPayerInfo,
  getStatusFromEventType,
  RedisHelper,
  type TPayPalResource,
  type TPayPalWebhookEvent,
  type TWebhookData,
} from '@helper';
import { createLogger, NotFoundError, PaymentError } from '@lib';
import { OrderModel, PaymentModel, type TOrder } from '@model';
import mongoose, { type HydratedDocument } from 'mongoose';
// Import directly from sibling modules to avoid circular deps through services/index.ts
import { logAudit } from '../audit';
import { emitPaymentStatus } from '../socket';
import { paypalService } from './service';

const logger = createLogger('PayPalHandler');

/**
 * Handles `PAYMENT.CAPTURE.*` events from PayPal.
 *
 * Resolves the payment by looking it up via `orderId`, determines the new
 * status from the event type, and atomically saves both the Payment and Order
 * documents inside a Mongoose transaction. Caches the result in Redis and
 * pushes a Socket.IO status update to the user.
 *
 * Idempotent: skips DB writes if the capture ID has already been recorded and
 * the payment is no longer in the PROCESSING state.
 *
 * @param eventType     - PayPal event type string, e.g. `PAYMENT.CAPTURE.COMPLETED`.
 * @param systemOrderId - Our internal orderId (stored as `custom_id` in PayPal).
 * @param captureId     - PayPal capture ID extracted from supplementary data or resource.id.
 */
export const processPaymentCaptureEvent = async (
  eventType: string,
  systemOrderId: string,
  captureId: string,
): Promise<void> => {
  const session = await mongoose.startSession();

  await session.withTransaction(async () => {
    const payment = await PaymentModel.findOne({ orderId: systemOrderId })
      .populate<{ order: HydratedDocument<TOrder> }>('order')
      .session(session);

    if (!payment) {
      logger.warn({ systemOrderId }, 'Payment not found — likely out-of-order webhook, will retry');
      throw new NotFoundError(`Payment not found for order ${systemOrderId}`);
    }

    if (!payment.order) {
      throw new NotFoundError(`Order not found for payment ${payment.paymentId}`);
    }

    const order = payment.order;

    // Skip if payment expired — mark as failed and notify the client so it
    // stops polling.
    if (payment.expiredAt < new Date() && payment.status === EPaymentStatus.Processing) {
      payment.status = EPaymentStatus.Failed;
      order.orderStatus = EOrderStatus.Failed;

      await payment.save({ session });
      await order.save({ session });

      try {
        await RedisHelper.paypal.paypalStatusSet(systemOrderId, {
          status: payment.status,
          userId: payment.userId,
          paymentId: payment.paymentId,
          cachedAt: Date.now(),
          orderId: order.orderId,
        } as TWebhookData);

        emitPaymentStatus(payment.userId, {
          orderId: order.orderId,
          paymentId: payment.paymentId,
          status: payment.status,
        });
      } catch (cacheErr) {
        logger.warn({ err: cacheErr, systemOrderId }, 'Failed to update cache/socket (non-critical)');
      }

      logger.info({ systemOrderId }, 'Payment expired, marked as failed');
      return;
    }

    // Already processed with the same capture ID — skip DB write and just
    // refresh the cache + notify the client with the existing status.
    if (payment.paypalTransaction?.paypalCaptureId === captureId && payment.status !== EPaymentStatus.Processing) {
      try {
        await RedisHelper.paypal.paypalStatusSet(systemOrderId, {
          status: payment.status,
          userId: payment.userId,
          paymentId: payment.paymentId,
          cachedAt: Date.now(),
          orderId: order.orderId,
        } as TWebhookData);

        emitPaymentStatus(payment.userId, {
          orderId: order.orderId,
          paymentId: payment.paymentId,
          status: payment.status,
        });
      } catch (cacheErr) {
        logger.warn({ err: cacheErr, systemOrderId }, 'Failed to update cache/socket (non-critical)');
      }
      return;
    }

    try {
      const statusUpdate = getStatusFromEventType(eventType);
      payment.status = statusUpdate.paymentStatus;
      order.orderStatus = statusUpdate.orderStatus;

      payment.updatedAt = new Date();
      order.updatedAt = new Date();

      await payment.save({ session });
      await order.save({ session });

      // Fire-and-forget audit log. Called inside withTransaction for simplicity;
      // logAudit uses its own session-less write so it commits independently.
      // In the rare event the transaction rolls back, the audit entry is orphaned
      // but this is an acceptable trade-off for a non-critical audit trail.
      logAudit({
        userId: payment.userId,
        action: 'PAYMENT',
        targetType: 'Transaction',
        targetId: payment.paymentId,
        metadata: { orderId: order.orderId, status: String(payment.status) },
      });

      try {
        await RedisHelper.paypal.paypalStatusSet(systemOrderId, {
          status: payment.status,
          userId: payment.userId,
          paymentId: payment.paymentId,
          cachedAt: Date.now(),
          orderId: order.orderId,
        } as TWebhookData);

        emitPaymentStatus(payment.userId, {
          orderId: order.orderId,
          paymentId: payment.paymentId,
          status: payment.status,
        });

        // Invalidate payment + order list caches after status change
        await Promise.all([
          RedisHelper.payment.paymentListInvalidate(),
          RedisHelper.order.orderListInvalidate(),
        ]);
      } catch (cacheErr) {
        logger.warn({ err: cacheErr, systemOrderId }, 'Failed to update cache/socket (non-critical)');
      }
    } catch (error) {
      // Even on failure, cache the current status and notify the client so
      // the frontend doesn't wait indefinitely. The status may still be
      // PROCESSING at this point, which is acceptable.
      try {
        await RedisHelper.paypal.paypalStatusSet(systemOrderId, {
          status: payment.status,
          userId: payment.userId,
          paymentId: payment.paymentId,
          cachedAt: Date.now(),
          orderId: order.orderId,
        } as TWebhookData);

        emitPaymentStatus(payment.userId, {
          orderId: order.orderId,
          paymentId: payment.paymentId,
          status: payment.status,
        });
      } catch (cacheErr) {
        logger.warn({ err: cacheErr, systemOrderId }, 'Failed to update cache/socket (non-critical)');
      }
      throw error;
    }
  });
};

/**
 * Handles `CHECKOUT.ORDER.APPROVED` events from PayPal.
 *
 * At this point the buyer has approved the PayPal checkout flow but the
 * capture has not happened yet. We persist the Order + Payment records from
 * the cached order data (stored in Redis during `createOrder`) and then
 * trigger the capture call to finalise payment.
 *
 * @param systemOrderId - Our internal orderId.
 * @param paypalOrderId - The PayPal order ID from `resource.id`.
 * @param resource      - The full webhook resource payload.
 */
export const handleCheckoutOrderApproved = async (
  systemOrderId: string,
  paypalOrderId: string,
  resource: TPayPalResource,
): Promise<void> => {
  if (!paypalOrderId) {
    throw new PaymentError('No PayPal Order ID found in CHECKOUT.ORDER.APPROVED webhook');
  }

  const { paypalPayerEmail, payerId } = await getPayerInfo(systemOrderId, resource);
  const orderData = await RedisHelper.order.orderGet(systemOrderId);
  if (!orderData) {
    throw new NotFoundError('No cached order data found for checkout');
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const [newOrder] = await OrderModel.create(
        [
          {
            orderId: systemOrderId,
            userId: orderData.userId,
            userInfoSnapshot: orderData.userInfoSnapshot,
            items: orderData.items,
            totalPrice: orderData.totalPrice,
            orderStatus: EOrderStatus.Created,
            paymentMethod: EPaymentMethod.Paypal,
          },
        ],
        { session },
      );

      await PaymentModel.create(
        [
          {
            order: newOrder._id,
            orderId: newOrder.orderId,
            userId: orderData.userId,
            status: EPaymentStatus.Processing,
            paypalTransaction: {
              paypalCaptureId: paypalOrderId,
              paypalPayerEmail,
              payerId,
              rawResponse: resource,
            },
          },
        ],
        { session },
      );
    });
  } finally {
    session.endSession();
  }

  // 3.2: Wrap each cleanup call independently so one failure doesn't block the other.
  // A failure here is non-critical — the worst outcome is the user briefly sees
  // "previous payment in progress" on their next order attempt.
  try {
    await RedisHelper.order.limitProcessingDel(orderData.userId);
  } catch (err) {
    logger.warn({ err, userId: orderData.userId }, 'Failed to delete processing limit (non-critical)');
  }
  try {
    await RedisHelper.order.orderDel(systemOrderId);
  } catch (err) {
    logger.warn({ err, systemOrderId }, 'Failed to delete cached order (non-critical)');
  }

  // Capture the PayPal order — this triggers the actual fund transfer.
  // Note (3.4): PayPal may send PAYMENT.CAPTURE.COMPLETED before this call returns.
  // That race is handled safely by the queue retry mechanism — the CAPTURE handler
  // looks up Payment by orderId, and if the APPROVED transaction hasn't committed yet
  // it throws NotFoundError, retries with backoff, and succeeds once APPROVED commits.
  await paypalService.capturePaypalOrder(paypalOrderId);
  logger.info({ paypalOrderId, systemOrderId }, 'PayPal order captured');
};

/**
 * Entry point for all incoming PayPal webhook events.
 *
 * Implements two layers of idempotency:
 * 1. Redis key check before acquiring a lock (fast-path skip).
 * 2. Redis distributed lock + double-check after acquiring the lock (prevents
 *    concurrent processing of the same event).
 *
 * After successful processing the event is recorded with a 24-hour TTL so
 * that PayPal retries are safely ignored.
 *
 * @param event         - The full PayPal webhook event payload.
 * @param systemOrderId - Our internal orderId extracted from `custom_id`.
 */
export const processWebhookEvent = async (event: TPayPalWebhookEvent, systemOrderId: string): Promise<void> => {
  const { event_type, resource, id: webhookId } = event;

  if (!webhookId) {
    throw new PaymentError('Webhook ID is missing');
  }

  const paypalOrderId = resource.id;
  const captureId = resource.supplementary_data?.related_ids?.capture || resource.id;

  // Build an idempotency key that is unique per webhook event + event type +
  // resource identifier to survive PayPal retries.
  // Reject if the resource identifier is missing — using 'unknown' could cause
  // unrelated events to share the same idempotency key and be silently skipped.
  let idempotencyKey: string;
  if (event_type === 'CHECKOUT.ORDER.APPROVED') {
    if (!paypalOrderId) {
      throw new PaymentError(`Missing PayPal order ID for ${event_type} idempotency key`);
    }
    idempotencyKey = `idempotency:${webhookId}:${event_type}:${paypalOrderId}`;
  } else {
    const resourceId = captureId || paypalOrderId;
    if (!resourceId) {
      throw new PaymentError(`Missing capture/order ID for ${event_type} idempotency key`);
    }
    idempotencyKey = `idempotency:${webhookId}:${event_type}:${resourceId}`;
  }

  // Fast path: already processed
  const alreadyProcessed = await RedisHelper.paypal.webhookProcessKeyGet(idempotencyKey);
  if (alreadyProcessed) {
    logger.debug({ idempotencyKey }, 'Webhook event already processed (fast-path skip)');
    return;
  }

  const lockKey =
    event_type === 'CHECKOUT.ORDER.APPROVED'
      ? `order:${systemOrderId}:${event_type}:${paypalOrderId}:${webhookId}`
      : `order:${systemOrderId}:${event_type}:${captureId}:${webhookId}`;

  return await RedisHelper.lock.withLock(lockKey, config.LOCK_WEBHOOK_PROCESSING_TTL_MS, async () => {
    // Double-check: another worker may have processed the event while we
    // waited to acquire the lock.
    const doubleCheck = await RedisHelper.paypal.webhookProcessKeyGet(idempotencyKey);
    if (doubleCheck) {
      logger.debug({ idempotencyKey }, 'Webhook event processed while acquiring lock (double-check skip)');
      return;
    }

    try {
      // For PAYMENT.CAPTURE events, check if we have a fresh cached result.
      // Re-emit if the status is terminal (non-PROCESSING) to ensure the
      // client gets notified even if the socket was briefly disconnected.
      if (event_type.includes('PAYMENT.CAPTURE')) {
        const cached = await RedisHelper.paypal.paypalStatusGet(systemOrderId);

        if (cached && Date.now() - cached.cachedAt < 5 * 60_000) {
          if (cached.status !== EPaymentStatus.Processing) {
            emitPaymentStatus(cached.userId, {
              orderId: cached.orderId,
              paymentId: cached.paymentId,
              status: cached.status,
            });
          }
          return;
        }
      }

      if (event_type === 'CHECKOUT.ORDER.APPROVED') {
        await handleCheckoutOrderApproved(systemOrderId, paypalOrderId!, resource);
      }

      switch (event_type) {
        case 'PAYMENT.CAPTURE.COMPLETED':
        case 'PAYMENT.CAPTURE.DENIED':
        case 'PAYMENT.CAPTURE.CANCELLED':
        case 'PAYMENT.CAPTURE.PENDING':
        case 'PAYMENT.CAPTURE.REFUNDED':
        case 'PAYMENT.CAPTURE.REVERSED':
          if (!captureId) {
            throw new PaymentError(`No capture ID found for event ${event_type}`);
          }
          await processPaymentCaptureEvent(event_type, systemOrderId, captureId);
          logger.info({ eventType: event_type, systemOrderId }, 'Payment capture event processed');
          break;

        case 'CHECKOUT.ORDER.COMPLETED':
          // Payment capture events handle the actual status update.
          logger.info({ systemOrderId }, 'Checkout order completed');
          break;

        default:
          logger.warn({ eventType: event_type, systemOrderId }, 'Unhandled webhook event type');
      }

      // Record idempotency key with a 24-hour TTL so PayPal retries are ignored.
      await RedisHelper.paypal.webhookProcessKeySet(
        idempotencyKey,
        JSON.stringify({
          processedAt: new Date().toISOString(),
          eventType: event_type,
          systemOrderId,
        }),
      );
    } catch (error) {
      logger.error({ err: error, eventType: event_type, systemOrderId }, 'Webhook event processing failed');
      throw error;
    }
  });
};
