import { config } from '@helper';
import { createLogger } from '@lib';

import { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';
import { createClient, RedisArgument, RedisJSON, type RedisClientOptions, type RedisClientType } from 'redis';

const logger = createLogger('Redis');

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

  //  COUNTER OPERATIONS
  async incre(): Promise<number> {
    return await this.client.incr(this.fullKey());
  }

  async increBy(increment: number): Promise<number> {
    return await this.client.incrBy(this.fullKey(), increment);
  }

  async decre(): Promise<number> {
    return await this.client.decr(this.fullKey());
  }

  async decreBy(decrement: number): Promise<number> {
    return await this.client.decrBy(this.fullKey(), decrement);
  }

  async getNumber(): Promise<number | null> {
    const value = await this.get();
    if (value === null) return null;

    const num = Number(value);
    return isNaN(num) ? null : num;
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

  // SORTED SET
  async zIncrBy(increment: number, member: string): Promise<number> {
    return await this.client.zIncrBy(this.fullKey(), increment, member);
  }
  async zRevRangeWithScores(start: number, stop: number): Promise<Array<{ value: string; score: number }>> {
    return await this.client.zRangeWithScores(this.fullKey(), start, stop, { REV: true });
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

    const flat: string[] = [];
    for (const [k, v] of Object.entries(keyOrObj as Record<string, any>)) {
      flat.push(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return this.client.hSet(this.fullKey(), flat as unknown as [string, string][]);
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
            logger.error('Max reconnection attempts reached');
            return new Error('Max reconnection attempts reached');
          }
          // Exponential backoff with maximum 30s
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

  // Eval helper
  async eval(script: string, keys: string[], args: string[]): Promise<any> {
    return await this._client.sendCommand(['EVAL', script, keys.length.toString(), ...keys, ...args]);
  }

  // lock helper
  async lockAcquire(key: string, ttlMs: number = 30000): Promise<string | null> {
    const value = randomUUID();
    const lockKey = `${this.prefix}:lock:${key}`;

    const result = await this._client.set(lockKey, value, {
      PX: ttlMs,
      NX: true,
    });

    return result === 'OK' ? value : null;
  }

  async lockRelease(key: string, value: string): Promise<void> {
    const lockKey = `${this.prefix}:lock:${key}`;

    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    try {
      await this.eval(script, [lockKey], [value]);
    } catch (error) {
      logger.error({ err: error, lockKey: key }, 'Failed to release lock');
    }
  }

  async lockExtend(key: string, value: string, ttlMs: number): Promise<boolean> {
    const lockKey = `${this.prefix}:lock:${key}`;

    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await this.eval(script, [lockKey], [value, ttlMs.toString()]);
    return result === 1;
  }

  async lockWithRetry(
    key: string,
    ttlMs: number = 30000,
    options?: { maxRetries?: number; retryDelay?: number },
  ): Promise<string> {
    const maxRetries = options?.maxRetries || 30;
    const retryDelay = options?.retryDelay || 100;

    for (let i = 0; i < maxRetries; i++) {
      const lock = await this.lockAcquire(key, ttlMs);
      if (lock) {
        return lock;
      }

      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    throw new Error(`Failed to acquire lock for key: ${key} after ${maxRetries} attempts`);
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
RedisInstance.event.on(ERedisEvent.Connect, () => logger.info('Redis connected'));
RedisInstance.event.on(ERedisEvent.Error, (e: Error) => logger.error({ err: e }, 'Redis error'));
RedisInstance.event.on(ERedisEvent.Reconnect, () => logger.warn('Redis reconnecting...'));
RedisInstance.event.on(ERedisEvent.Quit, () => logger.info('Redis disconnected'));

export default RedisInstance;
