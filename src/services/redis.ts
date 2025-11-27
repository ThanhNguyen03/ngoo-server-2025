import { config } from '@helper';
import { ERedisEvent, RedisClient, RedisHelperDerive } from '@lib';

/** Setup redis */
export const RedisInstance = RedisClient.getInstance(config.REDIS_KEY_PREFIX, {
  url: config.REDIS_URL,
});

// event log
RedisInstance.event.on(ERedisEvent.Connect, () => console.log('✅ Redis connected'));
RedisInstance.event.on(ERedisEvent.Error, (e) => console.error('Error something wrong with Redis: ', e));
RedisInstance.event.on(ERedisEvent.Reconnect, () => console.warn('Redis reconnecting...'));
RedisInstance.event.on(ERedisEvent.Quit, () => console.log('✅ Quit redis success...'));

// domain helpers
export const RedisHelperUser = RedisHelperDerive<'userAccessToken' | 'userInfo' | 'walletMessage'>(RedisInstance);
export const RedisHelperCategory = RedisHelperDerive<'category'>(RedisInstance);
export const RedisHelperItem = RedisHelperDerive<
  'itemBestSeller' | 'itemNewCollection' | 'itemByCategory' | 'itemById'
>(RedisInstance);

export default RedisInstance;
