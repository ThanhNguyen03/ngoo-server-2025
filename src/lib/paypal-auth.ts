/* eslint-disable camelcase */
import { config } from '@helper';
import axios from 'axios';
import { Request } from 'express';

let cachedToken: { token: string; exp: number } | null = null;

export const getPayPalAccessToken = async (): Promise<string> => {
  if (cachedToken && cachedToken.exp > Date.now()) {
    return cachedToken.token;
  }

  const res = await axios.post(`${config.PAYPAL_BASE_URL}/v1/oauth2/token`, 'grant_type=client_credentials', {
    auth: {
      username: config.PAYPAL_CLIENT_ID,
      password: config.PAYPAL_CLIENT_SECRET,
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  cachedToken = {
    token: res.data.access_token,
    exp: Date.now() + res.data.expires_in * 1000 - 60_000,
  };

  return cachedToken.token;
};

export const verifyWebhookSignature = async (req: Request): Promise<boolean> => {
  if (config.NODE_ENV !== 'production') {
    return true;
  }

  const accessToken = await getPayPalAccessToken();

  const res = await axios.post(
    `${config.PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`,
    {
      auth_algo: req.headers['paypal-auth-algo'],
      cert_url: req.headers['paypal-cert-url'],
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id: config.PAYPAL_WEBHOOK_ID,
      webhook_event: JSON.parse(req.body.toString()),
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    },
  );

  return res.data.verification_status === 'SUCCESS';
};
