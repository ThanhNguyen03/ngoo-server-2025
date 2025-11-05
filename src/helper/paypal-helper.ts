import { CheckoutPaymentIntent, OrderRequest } from '@paypal/paypal-server-sdk';
import { OrderItemInput } from '@/generated/graphql';
import { TItem, TPayment } from '@/model';
import { Types } from 'mongoose';

type TCreatePayPalOrderBodyInput = {
  totalPrice: number;
  orders: OrderItemInput[];
  listItemInfo: TItem[];
  orderMongoId: Types.ObjectId;
  orderId: string;
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
  const { totalPrice, orders, orderMongoId, orderId, listItemInfo } = input;

  const paypalItems = listItemInfo.map((item) => {
    return {
      name: item.name,
      quantity: orders.find((order) => order.itemId === item.itemId)!.amount.toString(),
      unitAmount: {
        currencyCode: 'USD',
        value: item.price.toFixed(2),
      },
      description: item.description || '',
      imageUrl: item.image,
    };
  });

  return {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: [
      {
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
        customId: orderMongoId.toString(),
        invoiceId: `INV-${orderId}`, // must be unique
        items: paypalItems,
      },
    ],
  };
};
