import 'dotenv/config';
import Joi from 'joi';

export const camelToSnakeCase = (str: string) => str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const NGOO_TABLE = {
  user: '',
  userInfo: '',
  category: '',
  loginMethod: '',
  item: '',
  order: '',
  payment: '',
  auditLog: '',
};

export type TTableName = typeof NGOO_TABLE;

const envSchema = Joi.object({
  PORT: Joi.number().required(),
  HOST: Joi.string().required(),
  APP_URL: Joi.string(),
  NODE_ENV: Joi.string().valid('local', 'test', 'prod').required(),
  FE_ALLOWED_URL: Joi.string().uri().required(),

  // secret — HS256 requires at least 256 bits (32 bytes) for cryptographic security
  JWT_SECRET_KEY: Joi.string().min(32).required(),
  EXPRESS_SESSION_SECRET: Joi.string().min(32).required(),

  // authen
  GOOGLE_CLIENT_ID: Joi.string().required(),

  // db
  MONGODB_URL: Joi.string().required(),
  MONGODB_TABLE_NAME: Joi.string().required(),

  // redis
  REDIS_URL: Joi.string()
    .trim()
    .regex(/^rediss:\/\//)
    .required(),
  REDIS_KEY_PREFIX: Joi.string().trim().optional().default('thanhfng_server'),

  // logging
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').optional().default('info'),

  // paypal
  PAYPAL_CLIENT_ID: Joi.string().required(),
  PAYPAL_CLIENT_SECRET: Joi.string().required(),
  PAYPAL_WEBHOOK_ID: Joi.string().required(),
  PAYPAL_MODE: Joi.string().valid('sandbox', 'live').required(),

  // --- Crypto Payment ---
  CRYPTO_PAYMENT_ENABLED: Joi.boolean().default(false),
  // Must use HTTPS or WSS to prevent RPC traffic interception
  BNB_RPC_URL: Joi.string()
    .uri({ scheme: ['https', 'wss'] })
    .when('CRYPTO_PAYMENT_ENABLED', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
  // Must be a valid ERC-55 address (0x + 40 hex chars)
  NGOO_CONTRACT_ADDRESS: Joi.string()
    .pattern(/^0x[0-9a-fA-F]{40}$/)
    .when('CRYPTO_PAYMENT_ENABLED', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
  NGOO_CHAIN_ID: Joi.number().default(97),
  // Must be a valid 32-byte hex private key (0x + 64 hex chars)
  NGOO_SIGNER: Joi.string()
    .pattern(/^0x[0-9a-fA-F]{64}$/)
    .when('CRYPTO_PAYMENT_ENABLED', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
  CRYPTO_PROOF_TTL_SEC: Joi.number().optional().default(900),
  CRYPTO_BLOCK_CONFIRMATIONS: Joi.number().optional().default(5),
  CRYPTO_PRICE_CACHE_TTL_SEC: Joi.number().optional().default(60),
  CRYPTO_MONITOR_POLL_INTERVAL_MS: Joi.number().optional().default(15000),
  CACHE_CRYPTO_PROOF_TTL_SEC: Joi.number().optional().default(900),
  // Increased to 60s for the same reason as LOCK_PAYMENT_TTL_MS above.
  LOCK_CRYPTO_PAYMENT_TTL_MS: Joi.number().optional().default(60000),

  // --- Queue ---
  QUEUE_MAX_CONCURRENT: Joi.number().optional().default(10),
  QUEUE_MAX_RETRIES: Joi.number().optional().default(3),
  QUEUE_RETRY_DELAY_MS: Joi.number().optional().default(1000),
  QUEUE_MAX_RETRY_DELAY_MS: Joi.number().optional().default(30000),
  QUEUE_STALLED_TIMEOUT_MS: Joi.number().optional().default(30000),

  // --- Rate Limiting ---
  RATE_LIMIT_ORDER_BUCKET_SIZE: Joi.number().optional().default(5),
  RATE_LIMIT_ORDER_REFILL_RATE: Joi.number().optional().default(1),
  RATE_LIMIT_ORDER_INTERVAL_SEC: Joi.number().optional().default(60),
  RATE_LIMIT_PAYMENT_BUCKET_SIZE: Joi.number().optional().default(3),
  RATE_LIMIT_PAYMENT_REFILL_RATE: Joi.number().optional().default(1),
  RATE_LIMIT_PAYMENT_INTERVAL_SEC: Joi.number().optional().default(300),
  RATE_LIMIT_AUTH_BUCKET_SIZE: Joi.number().optional().default(10),
  RATE_LIMIT_AUTH_REFILL_RATE: Joi.number().optional().default(1),
  RATE_LIMIT_AUTH_INTERVAL_SEC: Joi.number().optional().default(60),
  RATE_LIMIT_ADMIN_BUCKET_SIZE: Joi.number().optional().default(30),
  RATE_LIMIT_ADMIN_REFILL_RATE: Joi.number().optional().default(5),
  RATE_LIMIT_ADMIN_INTERVAL_SEC: Joi.number().optional().default(60),
  // Public read queries (unauthenticated): 60 req/min per IP
  RATE_LIMIT_PUBLIC_QUERY_BUCKET_SIZE: Joi.number().optional().default(60),
  RATE_LIMIT_PUBLIC_QUERY_REFILL_RATE: Joi.number().optional().default(1),
  RATE_LIMIT_PUBLIC_QUERY_INTERVAL_SEC: Joi.number().optional().default(60),

  // --- Cache TTLs (seconds) ---
  CACHE_DEFAULT_TTL_SEC: Joi.number().optional().default(3600),
  // Increased to 900s (15 min) to match PayPal's order approval window.
  // Previously 180s (3 min) which caused cache-miss NotFoundErrors when users
  // took >3 min to approve on PayPal's hosted page.
  CACHE_ORDER_CHECKOUT_TTL_SEC: Joi.number().optional().default(900),
  CACHE_ORDER_LIMIT_PROCESSING_TTL_SEC: Joi.number().optional().default(120),
  CACHE_ORDER_LIMIT_ATTEMPT_TTL_SEC: Joi.number().optional().default(600),
  CACHE_PAYPAL_STATUS_TTL_SEC: Joi.number().optional().default(300),
  CACHE_PAYPAL_WEBHOOK_IDEMPOTENCY_TTL_SEC: Joi.number().optional().default(604800),
  // Short-lived caches for list queries — keeps admin dashboards snappy without
  // hitting MongoDB on every page refresh. Invalidated on write operations.
  CACHE_ORDER_LIST_TTL_SEC: Joi.number().optional().default(30),
  CACHE_PAYMENT_LIST_TTL_SEC: Joi.number().optional().default(60),
  CACHE_ITEM_LIST_TTL_SEC: Joi.number().optional().default(30),

  // --- Lock TTLs (milliseconds) ---
  // Increased to 60s to cover: multiple DB queries + transaction (2-3 saves) +
  // Redis ops + socket emit on slow DB. 30s was too tight.
  LOCK_PAYMENT_TTL_MS: Joi.number().optional().default(60000),
  LOCK_WEBHOOK_PROCESSING_TTL_MS: Joi.number().optional().default(60000),

  // --- JWT ---
  JWT_ACCESS_TOKEN_EXP: Joi.string().optional().default('60m'),
  JWT_REFRESH_TOKEN_EXP: Joi.string().optional().default('30d'),

  // --- MongoDB ---
  MONGODB_MAX_POOL_SIZE: Joi.number().optional().default(20),
  MONGODB_MIN_POOL_SIZE: Joi.number().optional().default(5),
  MONGODB_MAX_IDLE_TIME_MS: Joi.number().optional().default(30000),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: Joi.number().optional().default(5000),

  // --- PayPal Service ---
  PAYPAL_CLIENT_TIMEOUT_MS: Joi.number().optional().default(30000),
  PAYPAL_WEBHOOK_TIMEOUT_MS: Joi.number().optional().default(10000),

  // --- Payment ---
  PAYMENT_DEFAULT_EXPIRY_MS: Joi.number().optional().default(600000),

  // --- Session ---
  SESSION_COOKIE_MAX_AGE_SEC: Joi.number().optional().default(86400),
  REQUEST_BODY_LIMIT: Joi.string().optional().default('1mb'),
}).unknown(true);

const { value: envVars, error } = envSchema.validate(process.env, {
  abortEarly: false,
});

if (error) {
  throw new Error(`[Config validation error] ${error.details.map((d) => d.message).join(', ')}`);
}

// Warn about undeclared env vars that look like app config (possible typos in var names).
// Filters out common OS/shell vars (lowercase or known system names) to reduce noise.
const _knownEnvKeys = new Set(Object.keys((envSchema.describe() as { keys?: Record<string, unknown> }).keys ?? {}));
const _unknownAppKeys = Object.keys(process.env).filter(
  (k) => !_knownEnvKeys.has(k) && /^[A-Z][A-Z0-9_]{2,}_[A-Z0-9_]+$/.test(k),
);
if (_unknownAppKeys.length > 0) {
  // Logger is not yet initialized at config load time — console.warn is intentional here
  console.warn(`[Config] Unrecognized env vars (possible typos): ${_unknownAppKeys.join(', ')}`);
}

export const config = {
  PORT: envVars.PORT,
  HOST: envVars.HOST,
  APP_URL: envVars.APP_URL,
  NODE_ENV: envVars.NODE_ENV,
  FE_ALLOWED_URL: envVars.FE_ALLOWED_URL,

  // secret
  JWT_SECRET_KEY: envVars.JWT_SECRET_KEY,
  EXPRESS_SESSION_SECRET: envVars.EXPRESS_SESSION_SECRET,

  // authen
  GOOGLE_CLIENT_ID: envVars.GOOGLE_CLIENT_ID,

  // db
  MONGODB_URL: envVars.MONGODB_URL,
  MONGODB_TABLE_NAME: envVars.MONGODB_TABLE_NAME,

  // redis
  REDIS_URL: envVars.REDIS_URL,
  REDIS_KEY_PREFIX: envVars.REDIS_KEY_PREFIX,

  // logging
  LOG_LEVEL: envVars.LOG_LEVEL as 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace',

  // paypal
  PAYPAL_CLIENT_ID: envVars.PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: envVars.PAYPAL_CLIENT_SECRET,
  PAYPAL_WEBHOOK_ID: envVars.PAYPAL_WEBHOOK_ID,
  PAYPAL_MODE: envVars.PAYPAL_MODE,
  PAYPAL_BASE_URL: envVars.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',

  // --- Crypto Payment ---
  CRYPTO_PAYMENT_ENABLED: envVars.CRYPTO_PAYMENT_ENABLED as boolean,
  BNB_RPC_URL: envVars.BNB_RPC_URL as string | undefined,
  NGOO_CONTRACT_ADDRESS: envVars.NGOO_CONTRACT_ADDRESS as string | undefined,
  NGOO_CHAIN_ID: envVars.NGOO_CHAIN_ID as number,
  NGOO_SIGNER: envVars.NGOO_SIGNER as string | undefined,
  CRYPTO_PROOF_TTL_SEC: envVars.CRYPTO_PROOF_TTL_SEC as number,
  CRYPTO_BLOCK_CONFIRMATIONS: envVars.CRYPTO_BLOCK_CONFIRMATIONS as number,
  CRYPTO_PRICE_CACHE_TTL_SEC: envVars.CRYPTO_PRICE_CACHE_TTL_SEC as number,
  CRYPTO_MONITOR_POLL_INTERVAL_MS: envVars.CRYPTO_MONITOR_POLL_INTERVAL_MS as number,
  CACHE_CRYPTO_PROOF_TTL_SEC: envVars.CACHE_CRYPTO_PROOF_TTL_SEC as number,
  LOCK_CRYPTO_PAYMENT_TTL_MS: envVars.LOCK_CRYPTO_PAYMENT_TTL_MS as number,

  // --- Queue ---
  QUEUE_MAX_CONCURRENT: envVars.QUEUE_MAX_CONCURRENT as number,
  QUEUE_MAX_RETRIES: envVars.QUEUE_MAX_RETRIES as number,
  QUEUE_RETRY_DELAY_MS: envVars.QUEUE_RETRY_DELAY_MS as number,
  QUEUE_MAX_RETRY_DELAY_MS: envVars.QUEUE_MAX_RETRY_DELAY_MS as number,
  QUEUE_STALLED_TIMEOUT_MS: envVars.QUEUE_STALLED_TIMEOUT_MS as number,

  // --- Rate Limiting ---
  RATE_LIMIT_ORDER_BUCKET_SIZE: envVars.RATE_LIMIT_ORDER_BUCKET_SIZE as number,
  RATE_LIMIT_ORDER_REFILL_RATE: envVars.RATE_LIMIT_ORDER_REFILL_RATE as number,
  RATE_LIMIT_ORDER_INTERVAL_SEC: envVars.RATE_LIMIT_ORDER_INTERVAL_SEC as number,
  RATE_LIMIT_PAYMENT_BUCKET_SIZE: envVars.RATE_LIMIT_PAYMENT_BUCKET_SIZE as number,
  RATE_LIMIT_PAYMENT_REFILL_RATE: envVars.RATE_LIMIT_PAYMENT_REFILL_RATE as number,
  RATE_LIMIT_PAYMENT_INTERVAL_SEC: envVars.RATE_LIMIT_PAYMENT_INTERVAL_SEC as number,
  RATE_LIMIT_AUTH_BUCKET_SIZE: envVars.RATE_LIMIT_AUTH_BUCKET_SIZE as number,
  RATE_LIMIT_AUTH_REFILL_RATE: envVars.RATE_LIMIT_AUTH_REFILL_RATE as number,
  RATE_LIMIT_AUTH_INTERVAL_SEC: envVars.RATE_LIMIT_AUTH_INTERVAL_SEC as number,
  RATE_LIMIT_ADMIN_BUCKET_SIZE: envVars.RATE_LIMIT_ADMIN_BUCKET_SIZE as number,
  RATE_LIMIT_ADMIN_REFILL_RATE: envVars.RATE_LIMIT_ADMIN_REFILL_RATE as number,
  RATE_LIMIT_ADMIN_INTERVAL_SEC: envVars.RATE_LIMIT_ADMIN_INTERVAL_SEC as number,
  RATE_LIMIT_PUBLIC_QUERY_BUCKET_SIZE: envVars.RATE_LIMIT_PUBLIC_QUERY_BUCKET_SIZE as number,
  RATE_LIMIT_PUBLIC_QUERY_REFILL_RATE: envVars.RATE_LIMIT_PUBLIC_QUERY_REFILL_RATE as number,
  RATE_LIMIT_PUBLIC_QUERY_INTERVAL_SEC: envVars.RATE_LIMIT_PUBLIC_QUERY_INTERVAL_SEC as number,

  // --- Cache TTLs (seconds) ---
  CACHE_DEFAULT_TTL_SEC: envVars.CACHE_DEFAULT_TTL_SEC as number,
  CACHE_ORDER_CHECKOUT_TTL_SEC: envVars.CACHE_ORDER_CHECKOUT_TTL_SEC as number,
  CACHE_ORDER_LIMIT_PROCESSING_TTL_SEC: envVars.CACHE_ORDER_LIMIT_PROCESSING_TTL_SEC as number,
  CACHE_ORDER_LIMIT_ATTEMPT_TTL_SEC: envVars.CACHE_ORDER_LIMIT_ATTEMPT_TTL_SEC as number,
  CACHE_PAYPAL_STATUS_TTL_SEC: envVars.CACHE_PAYPAL_STATUS_TTL_SEC as number,
  CACHE_PAYPAL_WEBHOOK_IDEMPOTENCY_TTL_SEC: envVars.CACHE_PAYPAL_WEBHOOK_IDEMPOTENCY_TTL_SEC as number,
  CACHE_ORDER_LIST_TTL_SEC: envVars.CACHE_ORDER_LIST_TTL_SEC as number,
  CACHE_PAYMENT_LIST_TTL_SEC: envVars.CACHE_PAYMENT_LIST_TTL_SEC as number,
  CACHE_ITEM_LIST_TTL_SEC: envVars.CACHE_ITEM_LIST_TTL_SEC as number,

  // --- Lock TTLs (milliseconds) ---
  LOCK_PAYMENT_TTL_MS: envVars.LOCK_PAYMENT_TTL_MS as number,
  LOCK_WEBHOOK_PROCESSING_TTL_MS: envVars.LOCK_WEBHOOK_PROCESSING_TTL_MS as number,

  // --- JWT ---
  JWT_ACCESS_TOKEN_EXP: envVars.JWT_ACCESS_TOKEN_EXP as string,
  JWT_REFRESH_TOKEN_EXP: envVars.JWT_REFRESH_TOKEN_EXP as string,

  // --- MongoDB ---
  MONGODB_MAX_POOL_SIZE: envVars.MONGODB_MAX_POOL_SIZE as number,
  MONGODB_MIN_POOL_SIZE: envVars.MONGODB_MIN_POOL_SIZE as number,
  MONGODB_MAX_IDLE_TIME_MS: envVars.MONGODB_MAX_IDLE_TIME_MS as number,
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: envVars.MONGODB_SERVER_SELECTION_TIMEOUT_MS as number,

  // --- PayPal Service ---
  PAYPAL_CLIENT_TIMEOUT_MS: envVars.PAYPAL_CLIENT_TIMEOUT_MS as number,
  PAYPAL_WEBHOOK_TIMEOUT_MS: envVars.PAYPAL_WEBHOOK_TIMEOUT_MS as number,

  // --- Payment ---
  PAYMENT_DEFAULT_EXPIRY_MS: envVars.PAYMENT_DEFAULT_EXPIRY_MS as number,

  // --- Session ---
  SESSION_COOKIE_MAX_AGE_SEC: envVars.SESSION_COOKIE_MAX_AGE_SEC as number,
  REQUEST_BODY_LIMIT: envVars.REQUEST_BODY_LIMIT as string,
};

export const TABLE_NAME: TTableName = (() => {
  const keys = Object.keys(NGOO_TABLE);
  const result: any = {};
  for (let i = 0; i < keys.length; i += 1) {
    result[keys[i]] = `${config.MONGODB_TABLE_NAME || ''}${camelToSnakeCase(keys[i])}`;
  }
  return result;
})();

export default config;
