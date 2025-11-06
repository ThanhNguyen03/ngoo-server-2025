import { config } from '@/helper';
import { ERedisEvent, RedisClient, RedisHelperDerive } from '@/lib';

/** Setup redis */
export const RedisInstance = RedisClient.getInstance(config.REDIS_KEY_PREFIX, {
  url: config.REDIS_URL,
});

// event log
RedisInstance.event.on(ERedisEvent.Error, (e) => console.error('Error something wrong with Redis: ', e));
RedisInstance.event.on(ERedisEvent.Reconnect, () => console.warn('Redis reconnecting...'));

// domain helpers
export const RedisHelperUser = RedisHelperDerive<'userAccessToken' | 'userInfo' | 'walletMessage'>(RedisInstance);

export default RedisInstance;
