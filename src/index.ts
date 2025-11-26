import { config } from '@helper';
import { RedisInstance } from '@service';
import mongoose from 'mongoose';
import { NGOO_API } from './app';

const connect = async () => {
  try {
    console.log('🚀 Initializing services...');

    // connect mongo db
    await mongoose.connect(config.MONGODB_URL, {
      autoIndex: true,
      serverSelectionTimeoutMS: 5000,
      dbName: config.MONGODB_TABLE_NAME,
    });
    console.log('✅ MongoDB connected');
    // start application
    await NGOO_API.payload();
  } catch (err) {
    console.error('❌ Connection failed:', err);
    if (RedisInstance.redis.isOpen) {
      RedisInstance.redis.quit();
    }
    process.exit(1); // quit db
  }
};

process.on('SIGINT', async () => {
  console.log('⚠️ Shutting down...');
  await RedisInstance.redis.flushAll();
  await RedisInstance.quit();
  await mongoose.disconnect();
  console.log('✅ Disconnect MongoDB...');
  console.log('✅ Done');
  process.exit(0);
});

connect();
