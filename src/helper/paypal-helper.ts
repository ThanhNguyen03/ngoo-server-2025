import { EPaymentStatus, OrderItemInput, TUserInfoSnapshot } from '@generated/graphql';
import { PaymentModel, TItem, TOrder, TPayment } from '@model';
import {
  CheckoutPaymentIntent,
  Item,
  ItemCategory,
  OrderApplicationContextShippingPreference,
  OrderRequest,
} from '@paypal/paypal-server-sdk';
import { ordersController } from '@service';
import { Document, Types } from 'mongoose';

type TCreatePayPalOrderBodyInput = {
  userInfo: TUserInfoSnapshot;
  totalPrice: number;
  orders: OrderItemInput[];
  listItemInfo: TItem[];
  orderId: string;
  cancelUrl?: string;
  returnUrl?: string;
};

/**
 * Builds a PayPal `OrderRequest` object from validated DB items + cart data.
 *
 * @param {Object} input
 * @param {number} input.totalPrice - Total order amount (already calculated server-side)
 * @param {OrderItemInput[]} input.orders - Cart items from FE (for quantity mapping)
 * @param {TItem[]} input.listItemInfo - Matching DB item documents (trusted pricing source)
 * @param {Types.ObjectId} input.orderMongoId - MongoDB document `_id`, stored in PayPal `customId`
 * @param {string} input.orderId - Human-friendly order ID (stored in `invoiceId`)
 *
 * @returns {Promise<OrderRequest>} Fully constructed PayPal order body
 *
 * @throws {Error} If item from cart cannot be matched with DB record
 *
 * @example
 * const body = await createPayPalOrderBody({
 *   totalPrice: 49.99,
 *   orders: [{ itemId: 'A1', amount: 2 }],
 *   listItemInfo: dbItems,
 *   orderMongoId: order._id,
 *   orderId: order.orderId,
 * });
 *
 * await ordersController.createOrder({ body });
 *
 * @note
 * - `currencyCode` is always `USD`
 * - `intent` is `Capture` (funds captured immediately after approval)
 * - `invoiceId` **must be unique** or PayPal rejects the order
 * - `customId` allows mapping PayPal → MongoDB later
 */
export const createPayPalOrderBody = async (input: TCreatePayPalOrderBodyInput): Promise<OrderRequest> => {
  const { userInfo, totalPrice, orders, orderId, listItemInfo, cancelUrl, returnUrl } = input;

  const paypalItems: Item[] = listItemInfo.map((item) => {
    const basePrice = item.discountPercent ? item.price - (item.price * item.discountPercent) / 100 : item.price;

    return {
      name: item.name,
      category: ItemCategory.PhysicalGoods,
      quantity: orders.find((order) => order.itemId === item.itemId)!.amount.toString(),
      unitAmount: {
        currencyCode: 'USD',
        value: basePrice.toString(),
      },
      description: item.description || '',
    };
  });

  return {
    intent: CheckoutPaymentIntent.Capture,
    payer: {
      emailAddress: userInfo.email,
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

        items: paypalItems,
      },
    ],
    applicationContext: {
      cancelUrl,
      returnUrl,
      shippingPreference: OrderApplicationContextShippingPreference.NoShipping,
    },
  };
};

/**
 * Capture a PayPal order and persist its transaction into the PaymentModel.
 * @param {string} id - The PayPal order ID that was previously created on the client
 *                      and stored in `order.paypalOrderId`.
 * @param {import("mongoose").Document & TPayment} newPayment - A newly created PaymentModel
 *                      document (typically with status `Pending`) that will be updated
 *                      after the capture result is returned from PayPal.
 *
 * @throws {Error} If PayPal does not return a capture record.
 * @throws {Error} If the capture ID was already stored (duplicate / replay attack).
 *
 * @returns {Promise<{
 *   result: Record<string, unknown>,
 *   paypalCaptureId: string,
 *   paypalPayerEmail: string,
 *   payerId: string
 * }>} Useful extracted PayPal fields for optional further logging.
 */
export const capturePaypalOrder = async (
  id: string,
  newPayment: Document<unknown, {}, TPayment, {}, {}> &
    TPayment & {
      _id: Types.ObjectId;
    } & {
      __v: number;
    },
) => {
  const { result } = await ordersController.captureOrder({ id });
  const capture = result.purchaseUnits?.[0]?.payments?.captures?.[0];
  const payer = result.payer;

  if (!capture) {
    throw new Error('PayPal capture missing in response');
  }

  // check capture status
  const captureId = capture.id ?? '';
  const paypalPayerEmail = payer?.emailAddress ?? '';
  const payerId = payer?.payerId ?? '';

  // Prevent duplicate captureId save
  const existed = await PaymentModel.findOne({
    'paypalTransaction.paypalCaptureId': captureId,
  }).populate<{ order: TOrder }>('order');

  if (existed) {
    throw new Error('This PayPal capture was already processed');
  }

  if (capture.status !== 'COMPLETED') {
    console.warn(`[PayPal Warning] Capture returned status "${capture.status}" for captureId=${captureId}`);
  }

  // fill payment object
  newPayment.paypalTransaction = {
    paypalCaptureId: captureId,
    paypalPayerEmail,
    payerId,
    rawResponse: result as Record<string, unknown>,
  };

  newPayment.status = capture.status === 'COMPLETED' ? EPaymentStatus.Success : EPaymentStatus.Failed;
  await newPayment.save();

  return { result, paypalCaptureId: captureId, paypalPayerEmail, payerId };
};

export const retryProcessing = async <T>(callback: () => Promise<T>, retries = 3, delay = 1500): Promise<T> => {
  try {
    return await callback();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, delay));
    return retryProcessing(callback, retries - 1, delay * 2);
  }
};
