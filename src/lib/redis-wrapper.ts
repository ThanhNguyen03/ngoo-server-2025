import { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';
import { createClient, RedisArgument, RedisJSON, type RedisClientOptions, type RedisClientType } from 'redis';

const parseHash = <T>(raw: Record<string, string>): T => {
  const obj: any = {};

  for (const [k, v] of Object.entries(raw)) {
    if (v === '') obj[k] = null;
    else if (v === 'true') obj[k] = true;
    else if (v === 'false') obj[k] = false;
    else if (!isNaN(Number(v))) obj[k] = Number(v);
    else if (v.startsWith('{') || v.startsWith('[')) {
      try {
        obj[k] = JSON.parse(v);
      } catch {
        obj[k] = v;
      }
    } else obj[k] = v;
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
    this._client.on('quit', () => this.event.emit(ERedisEvent.Quit));
    this._client.on('reconnecting', () => this.event.emit(ERedisEvent.Reconnect));
    this._client.on('error', (err) => this.event.emit(ERedisEvent.Error, err));
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

  async quit() {
    if (this._client.isOpen) {
      await this._client.quit();
    }
  }
}

export class RedisLock {
  constructor(private redisClient: RedisClient) {}

  private fullKey(key: string) {
    return `${this.redisClient.prefixValue}:lock:${key}`;
  }

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const value = randomUUID();
    const result = await this.redisClient.redis.set(this.fullKey(key), value, { PX: ttlMs, NX: true });
    return result === 'OK' ? value : null;
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
    await this.redisClient.redis.eval(lua, {
      keys: [this.fullKey(key)],
      arguments: [value],
    });
  }
}
