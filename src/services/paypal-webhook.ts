/* eslint-disable camelcase */
import { EOrderStatus, EPaymentStatus, TPaymentSocketResponse } from '@generated/graphql';
import { config, RedisHelper } from '@helper';
import { OrderModel, PaymentModel } from '@model';
import { io, paypalQueueService, paypalService } from '@service';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import express, { type Request, type Response } from 'express';
import mongoose from 'mongoose';

type TPayPalToken = {
  token: string;
  exp: number;
};
export class PaypalWebhook {
  private accessToken: TPayPalToken | null = null;
  private axiosInstance: AxiosInstance;

  private constructor() {
    // Initialize axios for direct API calls (for webhook verification)
    this.axiosInstance = axios.create({
      baseURL: config.PAYPAL_BASE_URL,
      timeout: 10000,
    });
  }

  public static create(): PaypalWebhook {
    return new PaypalWebhook();
  }

  private async getPayPalAccessToken() {
    if (this.accessToken && this.accessToken.exp > Date.now()) {
      return this.accessToken.token;
    }

    const res = await this.axiosInstance.post(`/v1/oauth2/token`, 'grant_type=client_credentials', {
      auth: {
        username: config.PAYPAL_CLIENT_ID,
        password: config.PAYPAL_CLIENT_SECRET,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    this.accessToken = {
      token: res.data.access_token,
      exp: Date.now() + res.data.expires_in * 1000 - 60_000,
    };

    return this.accessToken.token;
  }

  async verifyWebhookSignature(req: Request) {
    if (config.NODE_ENV !== 'production') {
      return true;
    }

    try {
      const accessToken = await this.getPayPalAccessToken();

      const verificationPayload = {
        auth_algo: req.headers['paypal-auth-algo'],
        cert_url: req.headers['paypal-cert-url'],
        transmission_id: req.headers['paypal-transmission-id'],
        transmission_sig: req.headers['paypal-transmission-sig'],
        transmission_time: req.headers['paypal-transmission-time'],
        webhook_id: config.PAYPAL_WEBHOOK_ID,
        webhook_event: typeof req.body === 'string' ? JSON.parse(req.body) : req.body,
      };

      const response = await this.axiosInstance.post(
        '/v1/notifications/verify-webhook-signature',
        verificationPayload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      return response.data.verification_status === 'SUCCESS';
    } catch (error) {
      console.error('[PayPalService] Webhook verification failed:', error);
      return false;
    }
  }
}

// Singleton for PayPal webhooks
const paypalWebhook = PaypalWebhook.create();

export type TWebhookData = TPaymentSocketResponse & {
  userId: string;
  cachedAt: number;
};

const processWebhookEvent = async (event: Record<string, unknown>, systemOrderId: string, captureId: string) => {
  const eventType = event.event_type as string;
  const resource = event.resource as any;

  // Idempotency check using Redis
  const webhookId = event.id as string;
  const resourceId = resource?.id;
  const idempotencyKey = `idempotency:${webhookId}:${resourceId}`;

  const alreadyProcessed = await RedisHelper.paypal.webhookProcessKeyGet(idempotencyKey);
  if (alreadyProcessed) {
    console.log(`[Webhook] Event already processed: ${idempotencyKey}`);
    return;
  }

  return await RedisHelper.lock.withLock(`order:${systemOrderId}`, 30000, async () => {
    // Double check idempotency sau khi có lock
    const doubleCheck = await RedisHelper.paypal.webhookProcessKeyGet(idempotencyKey);
    if (doubleCheck) {
      console.log(`[Webhook] Event processed while acquiring lock: ${idempotencyKey}`);
      return;
    }

    try {
      // Handle CHECKOUT.ORDER.APPROVED event
      if (eventType === 'CHECKOUT.ORDER.APPROVED') {
        if (!captureId) {
          throw new Error('No PayPal Order ID found in webhook');
        }

        // Capture PayPal order
        await paypalService.capturePaypalOrder(captureId);
        // Mark as processed
        await RedisHelper.paypal.webhookProcessKeySet(
          idempotencyKey,
          JSON.stringify({ processedAt: new Date().toISOString() }),
        );
        return;
      }

      // Handle PAYMENT.CAPTURE.* event
      if (eventType.includes('PAYMENT.CAPTURE')) {
        const cachedOrder = await RedisHelper.paypal.paypalStatusGet(systemOrderId);

        // Check if cache is still valid (less than 5 minutes old)
        if (
          cachedOrder &&
          Date.now() - cachedOrder.cachedAt < 5 * 60 * 1000 &&
          cachedOrder.status !== EPaymentStatus.Processing
        ) {
          // Still emit socket in case FE missed it
          io.to(cachedOrder.userId).emit('paymentStatus', {
            orderId: cachedOrder.orderId,
            paymentId: cachedOrder.paymentId,
            status: cachedOrder.status,
          });

          return;
        }

        // Query DB only 1 time
        const order = await OrderModel.findOne({ orderId: systemOrderId });
        if (!order) {
          throw new Error(`Order ${systemOrderId} not found`);
        }

        const payment = await PaymentModel.findOne({ order: order._id });
        if (!payment) {
          throw new Error(`Payment for order ${systemOrderId} not found`);
        }

        // Additional idempotency check in DB
        if (payment.paypalTransaction?.paypalCaptureId === captureId && payment.status !== EPaymentStatus.Processing) {
          // Cache status to idempotency DB
          await RedisHelper.paypal.paypalStatusSet(
            systemOrderId,
            JSON.stringify({
              status: payment.status,
              userId: payment.userId,
              paymentId: payment.paymentId,
              cachedAt: Date.now(),
              orderId: order.orderId,
            }),
          );

          // Emit socket
          io.to(payment.userId).emit('paymentStatus', {
            orderId: order.orderId,
            paymentId: payment.paymentId,
            status: payment.status,
          });

          return;
        }

        // Start transaction
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
          let shouldUpdate = false;
          switch (event.event_type) {
            case 'PAYMENT.CAPTURE.COMPLETED':
              payment.status = EPaymentStatus.Success;
              order.orderStatus = EOrderStatus.Paid;
              shouldUpdate = true;
              break;

            case 'PAYMENT.CAPTURE.DENIED':
              payment.status = EPaymentStatus.Failed;
              order.orderStatus = EOrderStatus.Failed;
              shouldUpdate = true;
              break;

            case 'PAYMENT.CAPTURE.CANCELLED':
              payment.status = EPaymentStatus.Cancelled;
              order.orderStatus = EOrderStatus.Cancelled;
              shouldUpdate = true;
              break;

            case 'PAYMENT.CAPTURE.PENDING':
              payment.status = EPaymentStatus.Processing;
              order.orderStatus = EOrderStatus.Pending;
              shouldUpdate = true;
              break;

            default:
              await session.abortTransaction();
              session.endSession();
              return;
          }

          if (shouldUpdate) {
            // Update payment transaction
            payment.paypalTransaction = {
              paypalCaptureId: captureId,
              paypalPayerEmail: resource.payer?.email_address ?? '',
              payerId: resource.payer?.payer_id ?? '',
              rawResponse: event,
            };
            payment.updatedAt = new Date();
            order.updatedAt = new Date();

            // Save with transaction
            await payment.save({ session });
            await order.save({ session });

            await session.commitTransaction();
            session.endSession();

            // Cache new status to idempotency DB
            await RedisHelper.paypal.paypalStatusSet(
              systemOrderId,
              JSON.stringify({
                status: payment.status,
                userId: payment.userId,
                paymentId: payment.paymentId,
                cachedAt: Date.now(),
                orderId: order.orderId,
              }),
            );

            // Emit socket
            io.to(payment.userId).emit('paymentStatus', {
              orderId: order.orderId,
              paymentId: payment.paymentId,
              status: payment.status,
            });
          }
        } catch (error) {
          await session.abortTransaction();
          session.endSession();
          throw error;
        }

        // Mark webhook event as processed
        await RedisHelper.paypal.webhookProcessKeySet(
          idempotencyKey,
          JSON.stringify({
            processedAt: new Date().toISOString(),
            status: payment.status,
          }),
        );
      }
    } catch (error) {
      console.error(`[Webhook] Error processing ${eventType} for order ${systemOrderId}:`, error);
      throw error;
    }
  });
};

// router
const router = express.Router();
router.post('/', async (req: Request, res: Response) => {
  try {
    const isValid = await paypalWebhook.verifyWebhookSignature(req);
    if (!isValid) {
      return res.status(400).send('Invalid webhook signature');
    }
    const rawBody = req.body as Buffer;
    const event = JSON.parse(rawBody.toString('utf8'));
    const resource = event.resource;

    // Extract IDs from webhook
    const systemOrderId = resource?.custom_id || resource?.purchase_units?.[0]?.custom_id;
    const paypalOrderId = resource?.id; // PayPal Order ID
    const captureId = resource?.id || resource?.supplementary_data?.related_ids?.capture;

    if (!systemOrderId) {
      console.error('[Webhook] No system orderId found in webhook');
      return res.sendStatus(200); // Still return 200 to prevent retries
    }

    // send status to prevent unnecessary retry
    res.sendStatus(200);

    const idToUse = event.event_type === 'CHECKOUT.ORDER.APPROVED' ? paypalOrderId : captureId;

    if (idToUse) {
      paypalQueueService.add(
        event,
        systemOrderId,
        idToUse || 'unknown',
        'high', // High priority for payment webhooks
      );
    } else {
      console.warn(`[Webhook] No ID found for event ${event.event_type}`);
    }
  } catch (err) {
    console.error('[PayPal Webhook Error]', err);
    res.sendStatus(200);
  }
});

// Initialize workers once
let workersInitialized = false;

export const initPaypalWebhookWorker = () => {
  if (workersInitialized) {
    console.log('[Webhook] Workers already initialized');
    return;
  }

  paypalQueueService.startWorker(async (job) => {
    const { event, orderId, captureId } = job;
    await processWebhookEvent(event, orderId, captureId);
  }, 10); // 10 concurrent workers

  workersInitialized = true;
  console.log('[Webhook] PayPal queue workers started');
};

export default router;
