/* eslint-disable camelcase */
import type { OrderItemInput, TUserInfoSnapshot } from '@generated/graphql';
import { config } from '@helper';
import type { TItem } from '@model';
import {
  CheckoutPaymentIntent,
  Client,
  Environment,
  ItemCategory,
  LogLevel,
  OrderApplicationContextShippingPreference,
  OrderApplicationContextUserAction,
  OrdersController,
  type Item,
  type OrderRequest,
} from '@paypal/paypal-server-sdk';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import type { Request } from 'express';

type TPayPalToken = {
  token: string;
  exp: number;
};

type TPaypalCapture = {
  paypalCaptureId: string;
  paypalPayerEmail: string;
  payerId: string;
  rawResponse: Record<string, unknown>;
};

type TCreatePayPalOrderBody = {
  userInfo: TUserInfoSnapshot;
  totalPrice: number;
  orders: OrderItemInput[];
  listItemInfo: TItem[];
  orderId: string;
  cancelUrl?: string;
  returnUrl?: string;
};

export class PaypalService {
  private static instance: PaypalService;
  private orderController: OrdersController;

  private constructor() {
    const paypalClient = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: config.PAYPAL_CLIENT_ID!,
        oAuthClientSecret: config.PAYPAL_CLIENT_SECRET!,
      },
      timeout: 30000,
      environment: Environment.Sandbox,
      logging: {
        logLevel: config.NODE_ENV === 'production' ? LogLevel.Error : LogLevel.Info,
        logRequest: { logBody: config.NODE_ENV !== 'production' },
        logResponse: { logHeaders: config.NODE_ENV !== 'production' },
      },
    });

    this.orderController = new OrdersController(paypalClient);
  }

  public static getInstance(): PaypalService {
    if (!PaypalService.instance) {
      PaypalService.instance = new PaypalService();
    }
    return PaypalService.instance;
  }

  async createPaypalOrder(order: TCreatePayPalOrderBody) {
    const { userInfo, totalPrice, orders, orderId, listItemInfo, cancelUrl, returnUrl } = order;

    // Validate input
    if (totalPrice <= 0) {
      throw new Error('Total price must be greater than 0');
    }

    const paypalItems: Item[] = listItemInfo.map((item) => {
      const basePrice = item.discountPercent ? item.price - (item.price * item.discountPercent) / 100 : item.price;
      const orderItem = orders.find((o) => o.itemId === item.itemId);
      if (!orderItem) {
        throw new Error(`Item ${item.itemId} not found in order items`);
      }

      return {
        name: item.name.substring(0, 127), // PayPal has 127 char limit
        category: ItemCategory.PhysicalGoods,
        quantity: orderItem.amount.toString(),
        unitAmount: {
          currencyCode: 'USD',
          value: basePrice.toFixed(2), // Format to 2 decimal places
        },
        description: (item.description || '').substring(0, 127),
      };
    });

    const orderBody: OrderRequest = {
      intent: CheckoutPaymentIntent.Capture,
      payer: {
        emailAddress: userInfo.email,
        name: {
          givenName: userInfo.name.split(' ')[0] || 'Customer',
          surname: userInfo.name.split(' ').slice(1).join(' ') || '',
        },
      },
      purchaseUnits: [
        {
          referenceId: orderId,
          amount: {
            currencyCode: 'USD',
            value: totalPrice.toFixed(2),
            breakdown: {
              itemTotal: {
                currencyCode: 'USD',
                value: totalPrice.toFixed(2),
              },
            },
          },
          customId: orderId,
          invoiceId: `INV-${orderId.slice(0, 8)}-${Date.now()}`,
          description: `Order #${orderId}`,
          items: paypalItems,
        },
      ],
      applicationContext: {
        cancelUrl,
        returnUrl,
        shippingPreference: OrderApplicationContextShippingPreference.NoShipping,
        userAction: OrderApplicationContextUserAction.PayNow,
      },
    };

    try {
      const { result, ...response } = await this.orderController.createOrder({
        body: orderBody,
      });

      if (!result || !result.id) {
        throw new Error('PayPal did not return order ID');
      }

      const approvalLink = result.links?.find((l) => l.rel === 'approve');

      return {
        result,
        data: response,
        paypalOrderId: result.id,
        approvalUrl: approvalLink?.href,
      };
    } catch (error) {
      console.error('[PayPalService] Create order failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      throw new Error(`PayPal order creation failed: ${errorMessage}`);
    }
  }

  async capturePaypalOrder(paypalOrderId: string) {
    try {
      const { result, ...response } = await this.orderController.captureOrder({
        id: paypalOrderId,
      });

      const capture = result.purchaseUnits?.[0]?.payments?.captures?.[0];
      const payer = result.payer;

      if (!capture || !capture.id) {
        throw new Error('PayPal capture missing in response');
      }

      const data: TPaypalCapture = {
        paypalCaptureId: capture.id,
        paypalPayerEmail: payer?.emailAddress || '',
        payerId: payer?.payerId || '',
        rawResponse: response,
      };

      return data;
    } catch (error) {
      console.error(`[PaypalService] Capture failed for order ${paypalOrderId}:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown capture error';
      throw new Error(`PayPal capture failed: ${errorMessage}`);
    }
  }
}

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
