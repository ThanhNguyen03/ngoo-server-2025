import { type TPayPalWebhookEvent } from '@helper';
import { createLogger } from '@lib';
import express, { type Request, type Response } from 'express';
import { LIST_RETRYABLE_ERROR } from 'src/constant';
import { processWebhookEvent } from './paypal/handler';
import { paypalQueueService } from './paypal/queue';
import { paypalWebhook } from './paypal/webhook';

const logger = createLogger('Webhook');

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
    logger.error({ err: error }, 'Webhook verification error');
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
      logger.warn({ eventType: event.event_type }, 'No system orderId found in webhook event');
      // Still return 200 to prevent PayPal retries
      return res.status(200).send('OK');
    }

    // For order events, use the order ID or event ID
    let captureId: string;
    if (event.event_type.includes('PAYMENT.CAPTURE')) {
      // Use capture ID from supplementary data or resource ID
      captureId = resource.supplementary_data?.related_ids?.capture || resource.id || event.id;
    } else if (event.event_type === 'CHECKOUT.ORDER.APPROVED') {
      // Use PayPal order ID
      captureId = resource.id || event.id;
    } else {
      // Fallback to event ID for other events
      captureId = event.id;
    }

    // Send immediate response (PayPal expects 200 OK plain text)
    res.status(200).send('OK');

    // Queue for background processing
    paypalQueueService.add(
      event,
      systemOrderId,
      captureId,
      'high', // Priority
    );

    logger.info({ eventType: event.event_type, systemOrderId }, 'Webhook event queued');
  } catch (error) {
    logger.error({ err: error }, 'Webhook route handler error');
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
    logger.warn('PayPal webhook workers already initialized, skipping');
    return;
  }

  paypalQueueService.startWorker(
    async (job) => {
      const { event, orderId } = job;

      try {
        await processWebhookEvent(event, orderId);
      } catch (error) {
        logger.error({ err: error, orderId }, 'Webhook worker failed to process job');

        // Implement retry logic based on error type
        if (shouldRetry(error)) {
          logger.info({ orderId }, 'Retryable error — requeueing job');
          throw error; // Let queue handle retry
        }

        // For non-retryable errors, log and do not rethrow (prevents infinite retry)
        logger.error({ err: error, orderId }, 'Non-retryable webhook error, discarding job');
      }
    },
    10, // Number of concurrent workers
  );

  workersInitialized = true;
  logger.info({ concurrency: 10 }, 'PayPal webhook workers started');
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
