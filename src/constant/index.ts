import { TItemOption } from '@generated/graphql';

export const LIST_REQUIRED_OPTION: TItemOption[] = [
  {
    group: 'size',
    name: 'M',
  },
  {
    group: 'size',
    name: 'L',
    extraPrice: 2,
  },
  {
    group: 'sweet',
    name: 'Less Sweet',
  },
  {
    group: 'sweet',
    name: 'Default Sweet',
  },
  {
    group: 'sweet',
    name: 'More Sweet',
  },
  {
    group: 'ice',
    name: 'Less Ices',
  },
  {
    group: 'ice',
    name: 'Default Ices',
  },
  {
    group: 'ice',
    name: 'More Ices',
  },
];

export const LIST_RETRYABLE_ERROR = [
  'MongoNetworkError',
  'MongoTimeoutError',
  'ECONNABORTED',
  'ETIMEDOUT',
  'RedisConnectionError',
  'ConnectionError',
  'NetworkError',
  'TimeoutError',
];
