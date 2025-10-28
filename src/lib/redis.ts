import { createClient, type RedisClientType, type RedisClientOptions } from 'redis';
import EventEmitter from 'node:events';

export enum ERedisEvent {
  Connect = 'connect',
  End = 'end',
  Reconnect = 'reconnecting',
  Error = 'error',
}

export type TRedisKeyValue = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, expireSeconds?: number) => Promise<void>;
  del: (key: string) => Promise<void>;
};

/** Factory create key-value helper */
const createRedisKeyValue = (client: RedisClientType, prefix: string) => {
  const wrapKey = (key: string) => `${prefix}:${key}`;

  const keyValue: TRedisKeyValue = {
    async get(key) {
      return await client.get(wrapKey(key));
    },
    async set(key, value, expireSeconds) {
      if (expireSeconds) {
        await client.setEx(wrapKey(key), expireSeconds, value);
      } else {
        await client.set(wrapKey(key), value);
      }
    },
    async del(key) {
      await client.del(wrapKey(key));
    },
  };

  return keyValue;
};

/** Generic derive helper */
export const RedisHelperDerive = <T extends string>(redisClient: RedisClient): Record<T, () => TRedisKeyValue> => {
  const proxy = new Proxy(
    {},
    {
      get(_, prop: string) {
        return () => createRedisKeyValue(redisClient.redis, prop);
      },
    },
  );

  return proxy as Record<T, () => TRedisKeyValue>;
};

/** RedisClient */
export class RedisClient {
  private static instanceMap = new Map<string, RedisClient>();
  private _client: RedisClientType;
  public event = new EventEmitter();
  private prefix: string;

  private constructor(prefix: string, options: RedisClientOptions) {
    this.prefix = prefix;
    this._client = createClient(options) as RedisClientType;

    // forward redis events to EventEmitter
    this._client.on('connect', () => this.event.emit(ERedisEvent.Connect));
    this._client.on('end', () => this.event.emit(ERedisEvent.End));
    this._client.on('reconnecting', () => this.event.emit(ERedisEvent.Reconnect));
    this._client.on('error', (err) => this.event.emit(ERedisEvent.Error, err));
  }

  static getInstance(prefix: string, options: RedisClientOptions) {
    if (!this.instanceMap.has(prefix)) {
      const instance = new RedisClient(prefix, options);
      this.instanceMap.set(prefix, instance);
    }
    return this.instanceMap.get(prefix)!;
  }

  async connect() {
    if (!this._client.isOpen) {
      await this._client.connect();
    }
    return this;
  }

  get redis() {
    return this._client;
  }

  set redis(_v: RedisClientType) {
    this._client = _v;
  }
}
