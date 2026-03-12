import { config } from '@helper';
import { createLogger } from '@lib';
import { io, paypalQueueService, RedisInstance } from '@service';
import mongoose from 'mongoose';
import { NGOO_API } from './app';
import { initPaypalWebhookWorker } from './services/webhook';

const logger = createLogger('Main');

const gracefulShutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  await paypalQueueService.shutdown(10000);
  io.close();
  httpServer.close();
  await RedisInstance.redis.flushAll();
  await RedisInstance.quit();
  await mongoose.disconnect();
  logger.info('Shutdown complete');
  process.exit(0);
};

let httpServer: import('http').Server;

const connect = async () => {
  try {
    logger.info('Initializing services...');

    // connect mongo db
    await mongoose.connect(config.MONGODB_URL, {
      autoIndex: true,
      serverSelectionTimeoutMS: config.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      dbName: config.MONGODB_TABLE_NAME,
      maxPoolSize: config.MONGODB_MAX_POOL_SIZE,
      minPoolSize: config.MONGODB_MIN_POOL_SIZE,
      maxIdleTimeMS: config.MONGODB_MAX_IDLE_TIME_MS,
    });
    logger.info('MongoDB connected');
    // start application
    httpServer = await NGOO_API.payload();
    initPaypalWebhookWorker();
  } catch (err) {
    logger.error({ err }, 'Connection failed — exiting');
    if (RedisInstance.redis.isOpen) {
      RedisInstance.redis.quit();
    }
    process.exit(1); // quit db
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

connect();
