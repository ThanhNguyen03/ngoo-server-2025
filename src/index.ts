import NGOO_API from './app';
import mongoose from 'mongoose';
import { config } from '@/helper';
import { createClient } from 'redis';

export const redis = createClient({
  url: config.REDIS_URL,
});

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

    // connect redis
    redis.on('error', function (err) {
      console.error('❌ Redis Client Error:', err);
    });
    await redis.connect();
    console.log('Redis status:', await redis.ping()); // "PONG"

    // start application
    await NGOO_API.payload();
  } catch (err) {
    console.error('❌ Connection failed:', err);
    if (redis.isOpen) {
      redis.destroy(); // quit redis
    }
    process.exit(1); // quit db
  }
};

process.on('SIGINT', async () => {
  console.log('⚠️ Shutting down...');
  await redis.quit();
  console.log('✅ Quit redis success...');
  await mongoose.disconnect();
  console.log('✅ Disconnect MongoDB...');
  console.log('✅ Done');
  process.exit(0);
});

connect();
