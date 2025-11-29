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

  // secret
  JWT_SECRET_KEY: Joi.string().required(),
  EXPRESS_SESSION_SECRET: Joi.string().required(),

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

  // paypal
  PAYPAL_CLIENT_ID: Joi.string().required(),
  PAYPAL_CLIENT_SECRET: Joi.string().required(),
  PAYPAL_MODE: Joi.string().valid('sandbox', 'live').required(),

  // crypto
  // NGOO_CONTRACT_ADDRESS: Joi.string().required(),
  // NGOO_CHAIN_ID: Joi.string().required(),
  // NGOO_SIGNER: Joi.string().required(),
  // MONAD_RPC_URL: Joi.string().required(),
}).unknown(true);

const { value: envVars, error } = envSchema.validate(process.env, {
  abortEarly: false,
});

if (error) {
  throw new Error(`[Config validation error] ${error.details.map((d) => d.message).join(', ')}`);
}

export const config = {
  PORT: envVars.PORT,
  HOST: envVars.HOST,
  APP_URL: envVars.APP_URL,
  NODE_ENV: envVars.NODE_ENV,

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

  // paypal
  PAYPAL_CLIENT_ID: envVars.PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: envVars.PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE: envVars.PAYPAL_MODE,

  // crypto
  // NGOO_CONTRACT_ADDRESS: envVars.NGOO_CONTRACT_ADDRESS,
  // NGOO_CHAIN_ID: envVars.NGOO_CHAIN_ID,
  // NGOO_SIGNER: envVars.NGOO_SIGNER,
  // MONAD_RPC_URL: envVars.MONAD_RPC_URL,
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
