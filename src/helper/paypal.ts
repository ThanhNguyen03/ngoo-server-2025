/**
 * Pure PayPal utility types and helpers.
 *
 * This module intentionally contains NO model imports and NO business logic.
 * All webhook processing handlers have been moved to
 * `src/services/paypal/handler.ts` to enforce the strict separation between
 * the helper layer (pure utilities) and the service layer (business logic).
 */
import { EOrderStatus, EPaymentStatus, type TPaymentSocketResponse } from '@generated/graphql';

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

