import { config } from '@/helper';
import { Client, Environment, LogLevel, OrdersController, PaymentsController } from '@paypal/paypal-server-sdk';

const paypalClient = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: config.PAYPAL_CLIENT_ID!,
    oAuthClientSecret: config.PAYPAL_CLIENT_SECRET!,
  },
  timeout: 30000,
  environment: Environment.Sandbox,
  logging: {
    logLevel: LogLevel.Info,
    logRequest: { logBody: false },
    logResponse: { logHeaders: true },
  },
});

export const ordersController = new OrdersController(paypalClient);
export const paymentController = new PaymentsController(paypalClient);

export default paypalClient;
