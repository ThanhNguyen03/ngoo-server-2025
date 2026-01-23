/* eslint-disable camelcase */
import { config, processWebhookEvent, type TPayPalWebhookEvent } from '@helper';
import { paypalQueueService } from '@service';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import express, { type Request, type Response } from 'express';
import { LIST_RETRYABLE_ERROR } from 'src/constant';

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
      maxRedirects: 0,
    });
  }

  public static create(): PaypalWebhook {
    return new PaypalWebhook();
  }

  private async getPayPalAccessToken() {
    if (this.accessToken && this.accessToken.exp > Date.now()) {
      return this.accessToken.token;
    }
    try {
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
    } catch (error) {
      console.error('[PayPalWebhook] Failed to get access token:', error);
      throw new Error('Failed to authenticate with PayPal');
    }
  }

  async verifyWebhookSignature(req: Request, event: any) {
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
        webhook_event: event,
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
      console.error('[PaypalWebhook] Webhook verification failed:', error);
      return false;
    }
  }
}

// Singleton for PayPal webhooks
const paypalWebhook = PaypalWebhook.create();

const verifyPaypalWebhook = async (req: Request, res: Response, next: Function) => {
  try {
    const rawBody = req.body as Buffer;
    const event = JSON.parse(rawBody.toString('utf8')) as TPayPalWebhookEvent;

    // Validate required fields
    if (!event.id || !event.event_type || !event.resource) {
      return res.status(400).send('Invalid webhook payload');
    }

    const isValid = await paypalWebhook.verifyWebhookSignature(req, event);
    if (!isValid) {
      return res.status(400).send('Invalid webhook signature');
    }
    // Store in request object
    req.webhookEvent = event;

    next();
  } catch (error) {
    console.error('[Webhook] Verification error:', error);
    return res.status(400).send('Invalid webhook payload');
  }
};

// router
const router = express.Router();
router.post('/', verifyPaypalWebhook, async (req: Request, res: Response) => {
  const event = req.webhookEvent!;

  try {
    const resource = event.resource;
    // Extract order information
    const systemOrderId = resource.custom_id || resource.purchase_units?.[0]?.custom_id;

    if (!systemOrderId) {
      console.warn('[Webhook] No system orderId found in event:', event.event_type);
      // Still return 200 to prevent PayPal retries
      return res.status(200).send('OK');
    }

    // Send immediate response (PayPal expects 200 OK plain text)
    res.status(200).send('OK');

    // Queue for background processing
    paypalQueueService.add(
      event,
      systemOrderId,
      event.event_type,
      'high', // Priority
    );

    console.log(`[Webhook] Queued ${event.event_type} for order ${systemOrderId}`);
  } catch (error) {
    console.error('[Webhook] Route handler error:', error);
    // Always return 200 to PayPal to prevent retries
    res.status(200).send('OK');
  }
});

let workersInitialized = false;
const shouldRetry = (error: any): boolean => {
  const errorName = error.name || '';
  const errorCode = error.code || '';

  return (
    LIST_RETRYABLE_ERROR.includes(errorName) ||
    LIST_RETRYABLE_ERROR.includes(errorCode) ||
    errorName.includes('Network') ||
    errorName.includes('Timeout') ||
    errorCode.includes('ECONN')
  );
};

export const initPaypalWebhookWorker = () => {
  if (workersInitialized) {
    console.log('[Webhook] Workers already initialized');
    return;
  }

  paypalQueueService.startWorker(
    async (job) => {
      const { event, orderId } = job;

      try {
        await processWebhookEvent(event, orderId);
      } catch (error) {
        console.error(`[Webhook Worker] Failed to process job for order ${orderId}:`, error);

        // Implement retry logic based on error type
        if (shouldRetry(error)) {
          console.log(`[Webhook Worker] Will retry job for order ${orderId}`);
          throw error; // Let queue handle retry
        }

        // For non-retryable errors, log and continue
        console.error(`[Webhook Worker] Non-retryable error for order ${orderId}:`, error);
      }
    },
    10, // Number of concurrent workers
  );

  workersInitialized = true;
  console.log('[Webhook] PayPal queue workers started (10 concurrent workers)');
};

// ==================== HEALTH CHECK ====================
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    workersInitialized,
    timestamp: new Date().toISOString(),
  });
});

export default router;
