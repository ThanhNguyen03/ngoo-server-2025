import { config } from '@helper';

import { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';
import { createClient, RedisArgument, RedisJSON, type RedisClientOptions, type RedisClientType } from 'redis';

const parseHash = <T>(raw: Record<string, string>): T => {
  const obj: any = {};

  for (const [k, v] of Object.entries(raw)) {
    if (v === '') {
      obj[k] = null;
    } else if (v === 'true') {
      obj[k] = true;
    } else if (v === 'false') {
      obj[k] = false;
    } else if (v === 'null') {
      obj[k] = null;
    } else if (!isNaN(Number(v)) && v.trim() !== '') {
      if (/^-?\d+(\.\d+)?$/.test(v)) {
        obj[k] = Number(v);
      } else {
        obj[k] = v;
      }
    } else if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
      try {
        obj[k] = JSON.parse(v);
      } catch {
        obj[k] = v;
      }
    } else {
      obj[k] = v;
    }
  }

  return obj as T;
};

export enum ERedisEvent {
  Connect = 'connect',
  Quit = 'quit',
  Reconnect = 'reconnecting',
  Error = 'error',
}

class RedisKey {
  constructor(
    private client: RedisClientType,
    private prefix: string,
    private key: string,
  ) {}

  private fullKey() {
    return `${this.prefix}:${this.key}`;
  }

  getFullKey() {
    return `${this.prefix}:${this.key}`;
  }

  // API
  async get() {
    return await this.client.get(this.fullKey());
  }
  async set(value: string, expireSeconds?: number) {
    if (expireSeconds) {
      await this.client.setEx(this.fullKey(), expireSeconds, value);
    } else {
      await this.client.set(this.fullKey(), value);
    }
  }
  async expire(exp: number) {
    await this.client.expire(this.fullKey(), exp);
  }
  async delete() {
    return await this.client.del(this.fullKey());
  }
  // set
  async setAdd(member: string) {
    return await this.client.sAdd(this.fullKey(), member);
  }
  async setRemove(member: string) {
    return await this.client.sRem(this.fullKey(), member);
  }
  async setMembers() {
    return await this.client.sMembers(this.fullKey());
  }
  async setHas(member: string) {
    return await this.client.sIsMember(this.fullKey(), member);
  }

  //  HASH
  async hashSet(keyOrObj: Record<string, any> | string, value?: any) {
    if (value !== undefined) {
      return this.client.hSet(
        this.fullKey(),
        keyOrObj as string,
        typeof value === 'object' ? JSON.stringify(value) : value,
      );
    }

    const flat: (string | number | Buffer)[] = [];
    for (const [k, v] of Object.entries(keyOrObj as Record<string, any>)) {
      flat.push(k, typeof v === 'object' ? JSON.stringify(v) : v);
    }
    return this.client.hSet(this.fullKey(), flat as any);
  }
  async hashGet<T>(field: RedisArgument) {
    const raw = await this.client.hGet(this.fullKey(), field);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  }
  async hashGetAll<T>() {
    const raw = await this.client.hGetAll(this.fullKey());
    return parseHash<T>(raw);
  }
  async hashDel(field: RedisArgument) {
    return await this.client.hDel(this.fullKey(), field);
  }

  //  JSON
  async jsonSet<T extends RedisJSON>(value: T, index?: number) {
    const path = index !== undefined ? `$[${index}]` : '$';
    return await this.client.json.set(this.fullKey(), path, value);
  }
  async jsonAppendArray<T extends RedisJSON>(value: T) {
    return await this.client.json.arrAppend(this.fullKey(), '$', value);
  }
  async jsonGet<T>(): Promise<T | null> {
    const res = await this.client.json.get(this.fullKey());
    return (res ?? null) as T | null;
  }

  // pipeline
  pipeline() {
    return this.client.multi();
  }
}

/** RedisClient */
const DEFAULT_BACKOFF_TIME = 30 * 1000; // 30s
export class RedisClient {
  public event = new EventEmitter();
  private static instanceMap = new Map<string, RedisClient>();
  private _client: RedisClientType;
  private prefix: string;
  private maxListeners = 20; // Set limit

  private _listeners: Record<string, (...args: any[]) => void>;

  private constructor(prefix: string, options: RedisClientOptions, backoffTime: number = DEFAULT_BACKOFF_TIME) {
    this.prefix = prefix;

    // retry strategy
    const clientOptions: RedisClientOptions = {
      ...options,
      socket: {
        ...options.socket,
        reconnectStrategy: (retries: number) => {
          if (retries > 10) {
            console.error('[Redis] Max reconnection attempts reached');
            return new Error('Max reconnection attempts reached');
          }
          // Exponential backoff với max 30s
          return Math.min(retries * 1000, backoffTime);
        },
      },
    };
    this._client = createClient(clientOptions) as RedisClientType;
    // Set max listeners to prevent memory leak
    this.event.setMaxListeners(this.maxListeners);

    // Define listeners first
    const onConnect = () => this.event.emit(ERedisEvent.Connect);
    const onQuit = () => this.event.emit(ERedisEvent.Quit);
    const onReconnecting = () => this.event.emit(ERedisEvent.Reconnect);
    const onError = (err: Error) => this.event.emit(ERedisEvent.Error, err);

    // forward redis events to EventEmitter
    this._client.on('connect', onConnect);
    this._client.on('quit', onQuit);
    this._client.on('reconnecting', onReconnecting);
    this._client.on('error', onError);

    // Store listeners to cleanup
    this._listeners = { onConnect, onQuit, onReconnecting, onError };
  }

  get redis() {
    return this._client;
  }

  set redis(_v: RedisClientType) {
    this._client = _v;
  }

  get prefixValue() {
    return this.prefix;
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

  async ping(): Promise<boolean> {
    try {
      await this._client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async quit() {
    if (this._client.isOpen) {
      // Remove listeners before quit
      if (this._listeners) {
        this._client.off('connect', this._listeners.onConnect);
        this._client.off('quit', this._listeners.onQuit);
        this._client.off('reconnecting', this._listeners.onReconnecting);
        this._client.off('error', this._listeners.onError);
      }

      // Remove all listeners from EventEmitter
      this.event.removeAllListeners();

      await this._client.quit();
    }
  }
}

export class RedisLock {
  private defaultTtl = 30 * 1000; // 30s
  private retryDelay = 100; // 100ms
  private maxRetries = 30; // 30 * 100ms = 3s total

  constructor(
    private redisClient: RedisClient,
    private options?: { defaultTtl?: number; retryDelay?: number; maxRetries?: number },
  ) {
    if (options?.defaultTtl) {
      this.defaultTtl = options.defaultTtl;
    }
    if (options?.retryDelay) {
      this.retryDelay = options.retryDelay;
    }
    if (options?.maxRetries) {
      this.maxRetries = options.maxRetries;
    }
  }

  private fullKey(key: string) {
    return `${this.redisClient.prefixValue}:lock:${key}`;
  }

  async acquire(key: string, ttlMs?: number): Promise<string | null> {
    const value = randomUUID();
    const ttl = ttlMs || this.defaultTtl;

    const result = await this.redisClient.redis.set(this.fullKey(key), value, {
      PX: ttl,
      NX: true,
    });

    return result === 'OK' ? value : null;
  }

  // Thêm method acquire with retry
  async acquireWithRetry(
    key: string,
    ttlMs?: number,
    retryOptions?: { delay?: number; maxRetries?: number },
  ): Promise<string> {
    const ttl = ttlMs || this.defaultTtl;
    const delay = retryOptions?.delay || this.retryDelay;
    const maxRetries = retryOptions?.maxRetries || this.maxRetries;

    for (let i = 0; i < maxRetries; i++) {
      const lock = await this.acquire(key, ttl);
      if (lock) {
        return lock;
      }

      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error(`Failed to acquire lock for key: ${key} after ${maxRetries} attempts`);
  }

  async release(key: string, value: string) {
    const lua = `
      if redis.call("GET", KEYS[1]) == ARGV[1]
      then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    try {
      await this.redisClient.redis.eval(lua, {
        keys: [this.fullKey(key)],
        arguments: [value],
      });
    } catch (error) {
      console.error(`[RedisLock] Failed to release lock ${key}:`, error);
    }
  }

  // extend lock
  async extend(key: string, value: string, ttlMs: number): Promise<boolean> {
    const lua = `
      if redis.call("GET", KEYS[1]) == ARGV[1]
      then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await this.redisClient.redis.eval(lua, {
      keys: [this.fullKey(key)],
      arguments: [value, ttlMs.toString()],
    });

    return result === 1;
  }
}

/** Generic derive helper */
export const RedisHelperDerive = <T extends string>(redisClient: RedisClient): Record<T, (key: string) => RedisKey> => {
  const proxy = new Proxy(
    {},
    {
      get(_, prop: string) {
        return (key: string) => {
          return new RedisKey(redisClient.redis, redisClient.prefixValue, `${prop}:${key}`);
        };
      },
    },
  );

  return proxy as Record<T, (key: string) => RedisKey>;
};

/** Setup redis */
export const RedisInstance = RedisClient.getInstance(config.REDIS_KEY_PREFIX, {
  url: config.REDIS_URL,
});

// event log
RedisInstance.event.on(ERedisEvent.Connect, () => console.log('✅ Redis connected'));
RedisInstance.event.on(ERedisEvent.Error, (e) => console.error('Error something wrong with Redis: ', e));
RedisInstance.event.on(ERedisEvent.Reconnect, () => console.warn('Redis reconnecting...'));
RedisInstance.event.on(ERedisEvent.Quit, () => console.log('✅ Quit redis success...'));

export default RedisInstance;
