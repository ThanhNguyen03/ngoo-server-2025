import Joi from 'joi';
import 'dotenv/config';

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
type TNodeEnv = 'local' | 'test' | 'prod';

type TAppConfig = {
  PORT: number;
  APP_URL: string;
  NODE_ENV: TNodeEnv;
  MONGODB_URL: string;
  JWT_SECRET_KEY: string;
  EXPRESS_SESSION_SECRET: string;
  REDIS_URL: string;
  REDIS_KEY_PREFIX: string;
  MONGODB_TABLE_PREFIX: string;
  NGOO_CONTRACT_ADDRESS: string;
  NGOO_CHAIN_ID: string;
  NGOO_SIGNER: string;
  MONAD_RPC_URL: string;
};

const envSchema = Joi.object({
  PORT: Joi.number().required(),
  APP_URL: Joi.string().required(),
  NODE_ENV: Joi.string().valid('local', 'test', 'prod').required(),
  MONGODB_URL: Joi.string().required(),
  JWT_SECRET_KEY: Joi.string().required(),
  EXPRESS_SESSION_SECRET: Joi.string().required(),
  // SERVICE_CONFIG: Joi.string().required(),
  REDIS_URL: Joi.string()
    .trim()
    .regex(/^redis:\/\//)
    .required(),
  REDIS_KEY_PREFIX: Joi.string().trim().optional().default('thanhfng_server'),
  MONGODB_TABLE_PREFIX: Joi.string().required(),
  NGOO_CONTRACT_ADDRESS: Joi.string().required(),
  NGOO_CHAIN_ID: Joi.string().required(),
  NGOO_SIGNER: Joi.string().required(),
  MONAD_RPC_URL: Joi.string().required(),
}).unknown(true);

const { value: envVars, error } = envSchema.validate(process.env, {
  abortEarly: false,
});

if (error) {
  throw new Error(`[Config validation error] ${error.details.map((d) => d.message).join(', ')}`);
}

export const config = {
  PORT: envVars.PORT,
  APP_URL: envVars.APP_URL,
  NODE_ENV: envVars.NODE_ENV,
  MONGODB_URL: envVars.MONGODB_URL,
  JWT_SECRET_KEY: envVars.JWT_SECRET_KEY,
  EXPRESS_SESSION_SECRET: envVars.EXPRESS_SESSION_SECRET,
  REDIS_URL: envVars.REDIS_URL,
  REDIS_KEY_PREFIX: envVars.REDIS_KEY_PREFIX,
  MONGODB_TABLE_PREFIX: envVars.MONGODB_TABLE_PREFIX,
  NGOO_CONTRACT_ADDRESS: envVars.NGOO_CONTRACT_ADDRESS,
  NGOO_CHAIN_ID: envVars.NGOO_CHAIN_ID,
  NGOO_SIGNER: envVars.NGOO_SIGNER,
  MONAD_RPC_URL: envVars.MONAD_RPC_URL,
};

export const TABLE_NAME: TTableName = (() => {
  const keys = Object.keys(NGOO_TABLE);
  const result: any = {};
  for (let i = 0; i < keys.length; i += 1) {
    result[keys[i]] = `${config.MONGODB_TABLE_PREFIX || ''}${camelToSnakeCase(keys[i])}`;
  }
  return result;
})();

export default config;
