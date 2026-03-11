import type { OrderItemInput, TUserInfoSnapshot } from '@generated/graphql';
import { config } from '@helper';
import { createLogger } from '@lib';
import type { TItem } from '@model';

const logger = createLogger('PayPalService');
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
      environment: config.PAYPAL_MODE === 'live' ? Environment.Production : Environment.Sandbox,
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
      const extra = orderItem.selectedOptions
        ? orderItem.selectedOptions.reduce((sum, o) => sum + (o?.extraPrice || 0), 0)
        : 0;
      const finalPrice = basePrice + extra;

      return {
        name: item.name.substring(0, 127), // PayPal has 127 char limit
        category: ItemCategory.PhysicalGoods,
        quantity: orderItem.amount.toString(),
        unitAmount: {
          currencyCode: 'USD',
          value: finalPrice.toFixed(2), // Format to 2 decimal places
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
      logger.error({ err: error }, 'PayPal order creation failed');
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
      logger.error({ err: error, paypalOrderId }, 'PayPal order capture failed');
      const errorMessage = error instanceof Error ? error.message : 'Unknown capture error';
      throw new Error(`PayPal capture failed: ${errorMessage}`);
    }
  }
}

// Singleton for PayPal service
export const paypalService = PaypalService.getInstance();
