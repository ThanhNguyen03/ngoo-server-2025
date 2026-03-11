import { config } from '@helper';
import { createLogger } from '@lib';
import { paypalQueueService, RedisInstance } from '@service';
import mongoose from 'mongoose';
import { NGOO_API } from './app';
import { initPaypalWebhookWorker } from './services/webhook';

const logger = createLogger('Main');

const connect = async () => {
  try {
    logger.info('Initializing services...');

    // connect mongo db
    await mongoose.connect(config.MONGODB_URL, {
      autoIndex: true,
      serverSelectionTimeoutMS: 5000,
      dbName: config.MONGODB_TABLE_NAME,
    });
    logger.info('MongoDB connected');
    // start application
    await NGOO_API.payload();
    initPaypalWebhookWorker();
  } catch (err) {
    logger.error({ err }, 'Connection failed — exiting');
    if (RedisInstance.redis.isOpen) {
      RedisInstance.redis.quit();
    }
    process.exit(1); // quit db
  }
};

process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  // queue service
  await paypalQueueService.shutdown(10000);

  // redis
  await RedisInstance.redis.flushAll();
  await RedisInstance.quit();

  // db
  await mongoose.disconnect();
  logger.info('MongoDB disconnected');
  logger.info('Shutdown complete');
  process.exit(0);
});

connect();
