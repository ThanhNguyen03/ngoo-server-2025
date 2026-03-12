# ngoo-server-2025

GraphQL API server for the Ngoo food ordering platform. Built with **Apollo Server + Express**, **MongoDB**, **Redis**, and **Socket.IO**.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| API | Apollo Server 4 (GraphQL) + Express |
| Database | MongoDB via Mongoose (UUID business IDs, compound indexes) |
| Cache / Session | Redis (ioredis, connect-redis, distributed locking) |
| Real-time | Socket.IO (payment status push) |
| Auth | JWT (jose) + Google OAuth + argon2 (Argon2id) |
| Web3 | ethers v6 (wallet sign-to-verify, ECDSA) |
| Payments | PayPal REST SDK, COD |
| Logging | pino (structured JSON, child loggers per module) |
| Queue | In-memory priority queue with retry + graceful shutdown |
| Runtime | Node.js + TypeScript (tsx dev, rollup prod) |

---

## Development

```bash
# Install dependencies
yarn

# Copy env template
cp .example.env .env
# Fill in required values (see Environment Variables below)

# Dev server with hot reload
yarn dev

# Pretty-print logs in development
LOG_LEVEL=debug yarn dev | npx pino-pretty

# Production build
yarn build && yarn start
```

### Other commands

```bash
yarn lint        # ESLint check
yarn fix         # ESLint auto-fix
yarn check       # fix + prettier + build (full CI check)
yarn generate    # Regenerate GraphQL types after .graphql changes
```

---

## Architecture

### Layer separation (strict)

| Layer | Path | Rule |
|-------|------|------|
| Model | `src/model/` | DB schema + queries only. No business logic. |
| Helper | `src/helper/` | Pure utilities (Joi, JWT, Redis helpers). **No model imports.** |
| Service | `src/services/` | Business logic + side effects (can import model + helper). |
| Resolver | `src/apollo/app/` | GraphQL resolvers — orchestrate services and helpers only. |

### Startup flow

`src/index.ts` → MongoDB connect (with pool config) → `src/app.ts` bootstraps Express (helmet, CORS, body limits, session via Redis, Apollo Server) → mounts `/graphql` + `/webhook/paypal` → initializes Socket.IO + PayPal webhook worker → registers SIGTERM/SIGINT graceful shutdown handlers.

### Key files

| File | Purpose |
|------|---------|
| `src/lib/errors.ts` | `AppError` hierarchy: `NotFoundError`, `ValidationError`, `AuthenticationError`, `AuthorizationError`, `RateLimitError`, `PaymentError`, `ConflictError` |
| `src/lib/logger.ts` | pino factory — `createLogger('Context')` for per-module child loggers |
| `src/lib/queue.ts` | In-memory priority queue with concurrency control, retry/backoff, graceful shutdown |
| `src/services/user.ts` | `getOrCacheUserInfo()` — Redis-first with singleflight stampede prevention |
| `src/services/audit.ts` | `logAudit()` — fire-and-forget audit writer (never throws) |
| `src/services/paypal/handler.ts` | PayPal webhook business logic |
| `src/helper/common.ts` | Resolver wrappers (`publicWrapper`, `authorizedWrapper`, `adminWrapper`, …) |
| `src/helper/redis-helper.ts` | Typed Redis helpers organized by domain |
| `src/helper/rate-limit.ts` | Token bucket rate limiting (per user + per IP) |

### Resolver wrappers (`src/helper/common.ts`)

All resolvers use typed wrappers for auth and Joi validation:

| Wrapper | Auth | Notes |
|---------|------|-------|
| `publicWrapper(schema?, resolver)` | None | Guest context |
| `authorizedWrapper(schema?, resolver)` | JWT | Provides `userId`, `sid`, `role` in context |
| `adminWrapper(schema?, resolver)` | JWT + Admin role | Same as authorized + role check |
| `optionalAuthWrapper(schema?, resolver)` | Optional | Attempts JWT but doesn't fail |
| `rateLimitWrapper(config, resolver)` | — | Token bucket; must nest inside `authorizedWrapper` |
| `publicRateLimitWrapper(config, resolver)` | — | IP-based; must nest inside `publicWrapper` |

### Redis helpers (`src/helper/redis-helper.ts`)

Organized by domain: `account`, `category`, `item`, `order`, `paypal`, `lock`, `rateLimit`.

Notable:
- `RedisHelper.account.walletMessageGet/Set/Del` — nonce storage for wallet connection (15-min TTL)
- `RedisHelper.lock.withLock/withRetryLock` — distributed locking via Lua scripts
- `RedisHelper.rateLimit.tokenBucketConsume` — Lua-based token bucket

---

## GraphQL API

Endpoint: `POST /graphql` — Apollo Sandbox available in non-production environments.

### Domains

#### User (`src/apollo/app/user/`)
| Operation | Type | Auth | Description |
|-----------|------|------|-------------|
| `userInfo` | Query | Auth | Get current user profile |
| `cryptoWalletWithNonce` | Query | Auth | Get nonce message for wallet connection |
| `userRegister` | Mutation | Public | Register with email + password |
| `userLogin` | Mutation | Public | Google OAuth or credentials login |
| `userLogout` | Mutation | Auth | Revoke session(s) |
| `refreshToken` | Mutation | Public | Rotate access + refresh tokens |
| `userUpdateInfo` | Mutation | Auth | Update profile (transactional) |
| `userConnectCryptoWallet` | Mutation | Auth | Verify wallet signature + store address |

#### Category (`src/apollo/app/category/`) — Admin mutations
| Operation | Type | Auth |
|-----------|------|------|
| `listCategory` | Query | Public |
| `createCategory` | Mutation | Admin |
| `updateCategory` | Mutation | Admin |
| `deleteCategory` | Mutation | Admin |

#### Item (`src/apollo/app/item/`)
| Operation | Type | Auth | Description |
|-----------|------|------|-------------|
| `listItem` | Query | Public | Offset-based pagination |
| `listItemByCategory` | Query | Public | Filter by category |
| `listItemByStatus` | Query | Public | Filter by status |
| `listItemCursor` | Query | Public | **Cursor-based** (for infinite scroll) |
| `itemById` | Query | Public | Redis-cached |
| `createItem` | Mutation | Admin | — |
| `updateItem` | Mutation | Admin | — |
| `deleteItem` | Mutation | Admin | — |

#### Order (`src/apollo/app/order/`)
| Operation | Type | Auth |
|-----------|------|------|
| `getUserOrder` | Query | Auth |
| `listUserOrder` | Query | Auth |
| `createOrder` | Mutation | Auth |
| `approveCODPayment` | Mutation | Admin |

#### Audit Log (`src/apollo/app/audit-log/`) — Admin only
| Operation | Type | Description |
|-----------|------|-------------|
| `getAuditLog` | Query | Single log entry by ID |
| `listAuditLog` | Query | Paginated, filterable by userId/action/targetType |
| `createAuditLog` | Mutation | Manual audit entry |

---

## Payment Flows

### PayPal
1. `createOrder` → cache checkout data in Redis → return PayPal order ID to client
2. Client completes PayPal checkout UI
3. PayPal → `CHECKOUT.ORDER.APPROVED` webhook → order + payment persisted → capture triggered
4. PayPal → `PAYMENT.CAPTURE.COMPLETED` (or failure) → order status updated → Socket.IO push

### COD (Cash on Delivery)
1. `createOrder` → Order + Payment created in DB (transactional) → status `PENDING`
2. Admin `approveCODPayment` → status → `PAID` (transactional, rate-limited)
3. Socket.IO push to client

### Wallet Connection (EIP-191 sign-to-verify)
1. `cryptoWalletWithNonce` → server generates nonce, stores in Redis (15-min TTL)
2. Client signs with wallet (`personal_sign`)
3. `userConnectCryptoWallet(signature, address)` → `ethers.verifyMessage` recovers signer → address stored on `UserInfoModel` → cache invalidated

---

## Cursor Pagination

`listItemCursor` uses keyset pagination instead of `skip(N)` — O(log N) vs O(N) for deep pages:

- **Cursor format:** Base64URL `{ t: createdAt_ms, id: _id_hex }`
- **Query filter:** `{ $or: [{ createdAt: { $lt } }, { createdAt: eq, _id: { $lt } }] }`
- Fetches `limit + 1` to determine `hasMore`
- Returns `{ records, pageInfo: { hasMore, nextCursor } }`
- Existing offset-based queries (`listItem`, `listItemByCategory`, `listItemByStatus`) are unchanged

---

## Audit Logging

`logAudit()` (`src/services/audit.ts`) writes to the `AuditLog` collection. Fire-and-forget — never throws, failures logged via pino.

**Integrated into:** Category CRUD, Item CRUD, `userUpdateInfo`, payment capture webhook.

**Schema:** `user` and `targetId` stored as UUID strings (not ObjectId refs) for self-contained records that survive collection migrations.

---

## Security

- JWT access tokens in Redis allowlist — revocable per session or globally
- Refresh tokens verified by signature (stateless)
- Rate limiting: token bucket per user (admin, order, payment) + IP-based (auth)
- PayPal webhook signature verification + environment check
- Distributed locking for webhook idempotency (Lua scripts)
- Helmet.js security headers + CORS per environment
- All inputs validated with Joi schemas
- Passwords: argon2 (type: Argon2id, random salt)
- Wallet: ERC-55 checksum validated via `ethers.isAddress`, stored lowercase
- Wallet nonce: one-time use + 15-min Redis TTL (prevents replay)
- Body parser size limit: `config.REQUEST_BODY_LIMIT` (default `1mb`)

---

## Database Indexes

Compound indexes defined on models for query performance (no collection scans):

| Collection | Index | Query |
|------------|-------|-------|
| Item | `{ isDeleted: 1, createdAt: -1 }` | `listItem`, `listItemCursor` |
| Item | `{ isDeleted: 1, category: 1, createdAt: -1 }` | `listItemByCategory`, `listItemCursor` |
| Item | `{ isDeleted: 1, status: 1, createdAt: -1 }` | `listItemByStatus`, `listItemCursor` |
| Category | `{ isDeleted: 1, name: 1 }` | Category lookups |
| Order | `{ userId: 1, createdAt: -1 }` | Per-user order queries |
| Order | `{ userInfoSnapshot.email: 1, createdAt: -1 }` | Backward-compat email queries |
| AuditLog | `{ createdAt: -1 }`, `{ user: 1 }`, `{ targetType: 1, targetId: 1 }`, `{ action: 1, createdAt: -1 }` | Filtered listing |

---

## Environment Variables

See `.example.env` for the complete list with defaults. Required variables:

| Variable | Description |
|----------|-------------|
| `PORT` / `HOST` | Server bind address |
| `NODE_ENV` | `local` / `test` / `prod` |
| `MONGODB_URL` / `MONGODB_TABLE_NAME` | MongoDB connection |
| `REDIS_URL` | Redis connection |
| `JWT_SECRET_KEY` | Access token signing secret |
| `EXPRESS_SESSION_SECRET` | Session secret |
| `GOOGLE_CLIENT_ID` | Google OAuth |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID` / `PAYPAL_MODE` | PayPal |
| `FE_ALLOWED_URL` | Frontend CORS origin |

Optional tuning variables (all have safe defaults): `LOG_LEVEL`, MongoDB pool settings, Redis TTLs, JWT expiry, rate limit configs, queue concurrency, PayPal timeouts, request body limit.

---

## Logging

```bash
# Pretty-print in local development
LOG_LEVEL=debug yarn dev | npx pino-pretty

# Production (structured JSON to stdout)
LOG_LEVEL=warn yarn start
```

Each module creates a child logger: `const logger = createLogger('ModuleName')`. Error format: `logger.error({ err }, 'message')` — object first, string message second (pino convention).

---

## Changelog

See [PLAN.md](./PLAN.md) for the full sprint-by-sprint change log.

### Sprint 4.1 (2026-03-12)
Database index tuning, cursor-based pagination, audit log resolvers with mutation integration, Web3 wallet connection, `userUpdateInfo` transaction safety.

### Sprint 3 (2026-03-12)
Memory leak fixes, graceful shutdown, MongoDB connection pooling, cache stampede prevention, admin rate limits, 40+ env vars extracted, GraphQL type fixes.

### Sprint 2 (2026-03-12)
pino structured logging (replaced all `console.*`), CVE patches (apollo-server, axios, rollup), transaction safety for user registration, partial update fix.

### Sprint 1 (2026-03-11)
Typed error classes, `refreshToken` wrapper fix, `userLogout` simplification, mapper extraction, COD payment atomicity, PayPal handler service extraction.
