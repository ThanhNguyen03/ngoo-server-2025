/* eslint-disable camelcase */
import { config } from '@helper';
import { createLogger } from '@lib';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { type Request } from 'express';

const logger = createLogger('PayPalWebhook');

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
      timeout: config.PAYPAL_WEBHOOK_TIMEOUT_MS,
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
      logger.error({ err: error }, 'Failed to get PayPal access token');
      throw new Error('Failed to authenticate with PayPal');
    }
  }

  async verifyWebhookSignature(req: Request, event: any) {
    if (config.NODE_ENV !== 'prod') {
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
      logger.error({ err: error }, 'PayPal webhook signature verification failed');
      return false;
    }
  }
}

// Singleton for PayPal webhooks
export const paypalWebhook = PaypalWebhook.create();
