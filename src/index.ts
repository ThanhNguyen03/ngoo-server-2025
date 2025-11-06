import NGOO_API from './app';
import mongoose from 'mongoose';
import { config } from '@/helper';
import { RedisInstance } from '@/service';

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
    await RedisInstance.connect();
    console.log('✅ Redis connected');

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
  await RedisInstance.quit();
  console.log('✅ Quit redis success...');
  await mongoose.disconnect();
  console.log('✅ Disconnect MongoDB...');
  console.log('✅ Done');
  process.exit(0);
});

connect();
