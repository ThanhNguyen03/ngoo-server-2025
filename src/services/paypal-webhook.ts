import { EOrderStatus, EPaymentStatus, TPaymentSocketResponse } from '@generated/graphql';
import { retryProcessing } from '@helper';
import { OrderModel, PaymentModel } from '@model';
import express, { type Request, type Response } from 'express';
import { PaypalWebhook } from './paypal';
import { io } from './socket';

const router = express.Router();
const paypalWebhook = PaypalWebhook.create();

router.post('/', async (req: Request, res: Response) => {
  try {
    const isValid = await paypalWebhook.verifyWebhookSignature(req);
    if (!isValid) {
      return res.status(400).send('Invalid webhook signature');
    }
    const rawBody = req.body as Buffer;
    const event = JSON.parse(rawBody.toString('utf8'));
    const resource = event.resource;
    const orderId = resource?.custom_id || resource?.purchase_units?.[0]?.custom_id || resource?.reference_id;

    // send status to prevent unnecessary retry
    res.sendStatus(200);

    await retryProcessing(async () => {
      // Idempotency
      const existedPayment = await PaymentModel.findOne({
        'paypalTransaction.paypalCaptureId': resource.id,
      });
      if (existedPayment) {
        io.to(existedPayment.userId).emit('paymentStatus', {
          orderId,
          paymentId: existedPayment.paymentId,
          status: existedPayment.status,
        } as TPaymentSocketResponse);
        return;
      }

      const order = await OrderModel.findOne({ orderId });
      if (!order) {
        throw new Error('Order not found');
      }
      const payment = await PaymentModel.findOne({ order: order._id });
      if (!payment) {
        throw new Error('Payment not found');
      }

      switch (event.event_type) {
        case 'PAYMENT.CAPTURE.COMPLETED':
          payment.status = EPaymentStatus.Success;
          order.orderStatus = EOrderStatus.Paid;
          break;
        case 'PAYMENT.CAPTURE.DENIED':
          payment.status = EPaymentStatus.Failed;
          order.orderStatus = EOrderStatus.Failed;
          break;
        case 'PAYMENT.CAPTURE.CANCELLED':
          payment.status = EPaymentStatus.Cancelled;
          order.orderStatus = EOrderStatus.Cancelled;
          break;
        case 'PAYMENT.CAPTURE.PENDING':
          payment.status = EPaymentStatus.Processing;
          order.orderStatus = EOrderStatus.Pending;
          break;
        default:
          return;
      }

      payment.paypalTransaction = {
        paypalCaptureId: resource.id,
        paypalPayerEmail: resource.payer?.email_address ?? '',
        payerId: resource.payer?.payer_id ?? '',
        rawResponse: event,
      };

      await Promise.all([payment.save(), order.save()]);

      io.to(payment.userId).emit('paymentStatus', {
        orderId,
        paymentId: payment.paymentId,
        status: payment.status,
      });
    });

    res.sendStatus(200);
    console.log('webhook processed successfully');
  } catch (err) {
    console.error('[PayPal Webhook Error]', err);
    res.sendStatus(500);
  }
});

export default router;
