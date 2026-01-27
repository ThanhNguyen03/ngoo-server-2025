/* eslint-disable camelcase */
import { EOrderStatus, EPaymentStatus, type TPaymentSocketResponse } from '@generated/graphql';
import { PaymentModel, type TOrder, type TPayment } from '@model';
import { io, paypalService } from '@service';
import mongoose, { type ClientSession, type HydratedDocument } from 'mongoose';
import { RedisHelper } from './redis-helper';

export type TPayPalPayer = {
  email_address?: string;
  payer_id?: string;
};

export type TPayPalPurchaseUnit = {
  payer?: TPayPalPayer;
  custom_id?: string;
};

export type TPayPalSupplementaryData = {
  related_ids?: {
    capture?: string;
  };
};

export type TPayPalResource = {
  id?: string;
  payer?: TPayPalPayer;
  purchase_units?: TPayPalPurchaseUnit[];
  custom_id?: string;
  supplementary_data?: TPayPalSupplementaryData;
};

export type TPayPalWebhookEvent = {
  id: string;
  event_type: string;
  resource: TPayPalResource;
  create_time: string;
};

export type TWebhookData = TPaymentSocketResponse & {
  userId: string;
  cachedAt: number;
};

export type TCachePayerInfo = {
  paypalPayerEmail: string;
  payerId: string;
  saveAt: string;
};

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      webhookEvent?: TPayPalWebhookEvent;
    }
  }
}

export const getPayerInfo = async (systemOrderId: string, resource: TPayPalResource) => {
  let email: string = '';
  let payerId: string = '';

  // Try to get from resource first
  if (resource.payer?.email_address) {
    email = resource.payer.email_address;
  } else if (resource.purchase_units?.[0]?.payer?.email_address) {
    email = resource.purchase_units[0].payer.email_address;
  }

  if (resource.payer?.payer_id) {
    payerId = resource.payer.payer_id;
  } else if (resource.purchase_units?.[0]?.payer?.payer_id) {
    payerId = resource.purchase_units[0].payer.payer_id;
  }

  // Fallback to cache if not found
  if (!email || !payerId) {
    try {
      const cached = await RedisHelper.paypal.paypalCheckoutGet(systemOrderId);
      if (cached) {
        email ||= cached.paypalPayerEmail;
        payerId ||= cached.payerId;
      }
    } catch (error) {
      console.warn(`[Webhook] Failed to get cached payer info for ${systemOrderId}:`, error);
    }
  }

  return {
    paypalPayerEmail: email,
    payerId,
  };
};

export const getStatusFromEventType = (eventType: string) => {
  switch (eventType) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      return {
        paymentStatus: EPaymentStatus.Success,
        orderStatus: EOrderStatus.Paid,
      };
    case 'PAYMENT.CAPTURE.DENIED':
      return {
        paymentStatus: EPaymentStatus.Failed,
        orderStatus: EOrderStatus.Failed,
      };
    case 'PAYMENT.CAPTURE.CANCELLED':
      return {
        paymentStatus: EPaymentStatus.Cancelled,
        orderStatus: EOrderStatus.Cancelled,
      };
    case 'PAYMENT.CAPTURE.PENDING':
      return {
        paymentStatus: EPaymentStatus.Processing,
        orderStatus: EOrderStatus.Pending,
      };
    default:
      console.warn(`[Webhook] Unknown event type: ${eventType}`);
      return {
        paymentStatus: EPaymentStatus.Processing,
        orderStatus: EOrderStatus.Pending,
      };
  }
};

export const processPaymentCaptureEvent = async (
  payment: HydratedDocument<
    Omit<TPayment, 'order'> & {
      order: HydratedDocument<TOrder>;
    }
  >,
  order: HydratedDocument<TOrder>,
  session: ClientSession,
  eventType: string,
  systemOrderId: string,
  captureId: string,
  resource: TPayPalResource,
): Promise<void> => {
  // Skip if already processed with same capture ID and not in processing state
  if (payment.paypalTransaction?.paypalCaptureId === captureId && payment.status !== EPaymentStatus.Processing) {
    await RedisHelper.paypal.paypalStatusSet(systemOrderId, {
      status: payment.status,
      userId: payment.userId,
      paymentId: payment.paymentId,
      cachedAt: Date.now(),
      orderId: order.orderId,
    } as TWebhookData);

    io.to(payment.userId).emit('paymentStatus', {
      orderId: order.orderId,
      paymentId: payment.paymentId,
      status: payment.status,
    });
    return;
  }

  // Update status based on event type
  const statusUpdate = getStatusFromEventType(eventType);
  payment.status = statusUpdate.paymentStatus;
  order.orderStatus = statusUpdate.orderStatus;

  // Get payer info
  const { paypalPayerEmail, payerId } = await getPayerInfo(systemOrderId, resource);

  // Update payment transaction details
  payment.paypalTransaction = {
    paypalCaptureId: captureId,
    paypalPayerEmail,
    payerId,
    rawResponse: resource,
  };

  payment.updatedAt = new Date();
  order.updatedAt = new Date();

  // Save both documents
  await payment.save({ session });
  await order.save({ session });

  // Cache and emit
  await RedisHelper.paypal.paypalStatusSet(systemOrderId, {
    status: payment.status,
    userId: payment.userId,
    paymentId: payment.paymentId,
    cachedAt: Date.now(),
    orderId: order.orderId,
  } as TWebhookData);

  io.to(payment.userId).emit('paymentStatus', {
    orderId: order.orderId,
    paymentId: payment.paymentId,
    status: payment.status,
  });
};

export const processCheckoutOrderApproved = async (
  payment: HydratedDocument<
    Omit<TPayment, 'order'> & {
      order: HydratedDocument<TOrder>;
    }
  >,
  systemOrderId: string,
  paypalOrderId: string,
  resource: TPayPalResource,
): Promise<void> => {
  if (!paypalOrderId) {
    throw new Error('No PayPal Order ID found in CHECKOUT.ORDER.APPROVED webhook');
  }

  if (payment.expiredAt < new Date() && payment.status === EPaymentStatus.Processing) {
    console.log(`[Webhook] Payment ${systemOrderId} expired, skipping capture`);
    return;
  }

  const { paypalPayerEmail, payerId } = await getPayerInfo(systemOrderId, resource);

  await RedisHelper.paypal.paypalCheckoutSet(systemOrderId, {
    paypalPayerEmail,
    payerId,
    saveAt: new Date().toISOString(),
  } as TCachePayerInfo);

  // Capture the PayPal order
  await paypalService.capturePaypalOrder(paypalOrderId);
  console.log(`[Webhook] Captured PayPal order ${paypalOrderId} for system order ${systemOrderId}`);
};

export const processWebhookEvent = async (event: TPayPalWebhookEvent, systemOrderId: string): Promise<void> => {
  const { event_type, resource, id: webhookId } = event;

  if (!webhookId) {
    throw new Error('Webhook ID is missing');
  }

  const paypalOrderId = resource.id;
  const captureId = resource.supplementary_data?.related_ids?.capture || resource.id;

  // Create idempotency key based on event type
  let idempotencyKey: string;
  if (event_type === 'CHECKOUT.ORDER.APPROVED') {
    idempotencyKey = `idempotency:${webhookId}:${event_type}:${paypalOrderId || 'unknown'}`;
  } else {
    idempotencyKey = `idempotency:${webhookId}:${event_type}:${captureId || paypalOrderId || 'unknown'}`;
  }

  // Check if already processed
  const alreadyProcessed = await RedisHelper.paypal.webhookProcessKeyGet(idempotencyKey);
  if (alreadyProcessed) {
    console.log(`[Webhook] Event already processed: ${idempotencyKey}`);
    return;
  }

  // Create lock key
  const lockKey =
    event_type === 'CHECKOUT.ORDER.APPROVED'
      ? `order:${systemOrderId}:${event_type}:${paypalOrderId}`
      : `order:${systemOrderId}:${event_type}:${captureId}`;

  // Acquire lock to prevent concurrent processing
  return await RedisHelper.lock.withLock(lockKey, 30_000, async () => {
    // Double-check after acquiring lock
    const doubleCheck = await RedisHelper.paypal.webhookProcessKeyGet(idempotencyKey);
    if (doubleCheck) {
      console.log(`[Webhook] Event processed while acquiring lock: ${idempotencyKey}`);
      return;
    }

    const session = await mongoose.startSession();
    try {
      // Check cache for PAYMENT.CAPTURE events
      if (event_type.includes('PAYMENT.CAPTURE')) {
        const cached = await RedisHelper.paypal.paypalStatusGet(systemOrderId);

        if (cached && Date.now() - cached.cachedAt < 5 * 60_000) {
          // Only emit if status is terminal (not Processing)
          if (cached.status !== EPaymentStatus.Processing) {
            io.to(cached.userId).emit('paymentStatus', {
              orderId: cached.orderId,
              paymentId: cached.paymentId,
              status: cached.status,
            });
          }
          return;
        }
      }

      await session.withTransaction(async () => {
        const payment = await PaymentModel.findOne({ orderId: systemOrderId })
          .populate<{ order: HydratedDocument<TOrder> }>('order')
          .session(session);

        if (!payment) {
          throw new Error(`Payment not found for ${systemOrderId}`);
        }

        if (!payment.order) {
          throw new Error(`Order not found for payment ${payment.paymentId}`);
        }

        const order = payment.order;

        // Skip if payment expired
        if (payment.expiredAt < new Date() && payment.status === EPaymentStatus.Processing) {
          // Payment expired, mark as failed
          payment.status = EPaymentStatus.Failed;
          order.orderStatus = EOrderStatus.Failed;

          await payment.save({ session });
          await order.save({ session });

          // Cache và emit expired status
          await RedisHelper.paypal.paypalStatusSet(systemOrderId, {
            status: payment.status,
            userId: payment.userId,
            paymentId: payment.paymentId,
            cachedAt: Date.now(),
            orderId: order.orderId,
          } as TWebhookData);

          io.to(payment.userId).emit('paymentStatus', {
            orderId: order.orderId,
            paymentId: payment.paymentId,
            status: payment.status,
          });

          console.log(`[Webhook] Payment ${systemOrderId} expired, marked as failed`);
          return;
        }

        // Process based on event type
        switch (event_type) {
          case 'CHECKOUT.ORDER.APPROVED':
            await processCheckoutOrderApproved(payment, systemOrderId, paypalOrderId!, resource);
            break;

          case 'PAYMENT.CAPTURE.COMPLETED':
          case 'PAYMENT.CAPTURE.DENIED':
          case 'PAYMENT.CAPTURE.CANCELLED':
          case 'PAYMENT.CAPTURE.PENDING':
          case 'PAYMENT.CAPTURE.REFUNDED':
          case 'PAYMENT.CAPTURE.REVERSED':
            if (!captureId) {
              throw new Error(`No capture ID found for event ${event_type}`);
            }
            await processPaymentCaptureEvent(payment, order, session, event_type, systemOrderId, captureId, resource);
            console.log(`[Webhook] Processed ${event_type} for order ${systemOrderId}, status: ${payment.status}`);
            break;

          case 'CHECKOUT.ORDER.COMPLETED':
            // Just log for now, payment capture events will handle the actual processing
            console.log(`[Webhook] Order ${systemOrderId} completed`);
            break;

          default:
            console.warn(`[Webhook] Unhandled event type: ${event_type}`);
        }

        // Mark as processed (keep for 24 hours)
        await RedisHelper.paypal.webhookProcessKeySet(
          idempotencyKey,
          JSON.stringify({
            processedAt: new Date().toISOString(),
            eventType: event_type,
            systemOrderId,
          }),
        );
      });
    } catch (error) {
      console.error(`[Webhook] Error processing ${event_type} for order ${systemOrderId}:`, error);
      throw error;
    } finally {
      await session.endSession();
    }
  });
};
