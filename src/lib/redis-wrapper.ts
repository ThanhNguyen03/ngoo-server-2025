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
    return await this.client.sAdd(this.key, member);
  }
  async setRemove(member: string) {
    return await this.client.sRem(this.key, member);
  }
  async setMembers() {
    return await this.client.sMembers(this.key);
  }
  async setHas(member: string) {
    return await this.client.sIsMember(this.key, member);
  }

  //  HASH
  async hashSet(data: Record<string, any>) {
    const flat: (string | number | Buffer)[] = [];

    for (const [k, v] of Object.entries(data)) {
      let value: string | number | Buffer;

      if (v === null || v === undefined) {
        value = '';
      } else if (typeof v === 'object') {
        value = JSON.stringify(v);
      } else {
        value = v;
      }

      flat.push(k, value);
    }

    return this.client.hSet(this.fullKey(), flat as any);
  }

  async hashGet(field: RedisArgument) {
    return await this.client.hGet(this.fullKey(), field);
  }

  async hashGetAll<T>() {
    const raw = await this.client.hGetAll(this.fullKey());
    return parseHash<T>(raw);
  }

  //  JSON
  async jsonSet<T extends RedisJSON>(value: T) {
    await this.client.json.set(this.fullKey(), '$', value);
  }

  async jsonGet<T>() {
    return (await this.client.json.get(this.fullKey())) as T;
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
