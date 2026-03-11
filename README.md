# ngoo-server-2025

GraphQL API server built with Apollo Server, Express, MongoDB, Redis, and Socket.IO.

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **API:** Apollo Server (GraphQL)
- **Database:** MongoDB (Mongoose)
- **Cache / Locks:** Redis (token buckets, distributed locks, idempotency)
- **Real-time:** Socket.IO (payment status push)
- **Auth:** JWT (jose) + argon2 password hashing
- **Payments:** PayPal SDK, COD
- **Logging:** pino (structured JSON, child loggers per module)

## Development

```bash
yarn dev      # start with ts-node watch
yarn build    # compile to build/
yarn lint     # ESLint
```

## Architecture

### Layer separation

| Layer | Path | Rule |
|-------|------|------|
| Model | `src/model/` | DB schema + queries only. No business logic. |
| Helper | `src/helper/` | Pure utilities (JOI schemas, Redis helpers, JWT, pure PayPal type utilities). **No model imports.** |
| Service | `src/services/` | Business logic + side effects (webhook handlers, socket emit, user cache). |
| Resolver | `src/apollo/app/` | GraphQL resolvers — orchestrate helpers and services. |

### Key files

| File | Purpose |
|------|---------|
| `src/lib/errors.ts` | Typed error class hierarchy (`AppError`, `NotFoundError`, `ValidationError`, …) |
| `src/lib/logger.ts` | Pino logger factory — `createLogger('Context')` for per-module child loggers |
| `src/services/user.ts` | `getOrCacheUserInfo()` — Redis-first user info with DB fallback |
| `src/services/paypal/handler.ts` | PayPal webhook business logic (`processWebhookEvent`, etc.) |
| `src/helper/paypal.ts` | Pure PayPal type definitions + `getPayerInfo`, `getStatusFromEventType` |
| `src/helper/redis-helper.ts` | Typed Redis key helpers (account, order, paypal, lock) |
| `src/helper/common.ts` | Resolver wrappers (`publicWrapper`, `authorizedWrapper`, `adminWrapper`) |

### Error handling

All resolvers throw typed subclasses of `AppError` (`NotFoundError`, `ValidationError`, `AuthenticationError`, `AuthorizationError`, `RateLimitError`, `PaymentError`, `ConflictError`). Apollo's `formatError` uses `code` and `statusCode` from the base class for consistent error responses.

### Payment flows

**COD:** `createOrder` → persist Order + Payment in one transaction → `approveCODPayment` (admin, transactional, locked)

**PayPal:** `createOrder` → cache order in Redis → buyer approves on PayPal → `CHECKOUT.ORDER.APPROVED` webhook → persist Order + Payment → capture → `PAYMENT.CAPTURE.COMPLETED` webhook → emit Socket.IO status

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | Yes | — | HTTP server port |
| `HOST` | Yes | — | HTTP server host |
| `NODE_ENV` | Yes | — | `local` / `test` / `prod` |
| `LOG_LEVEL` | No | `info` | Pino log level: `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `MONGODB_URL` | Yes | — | MongoDB connection string |
| `MONGODB_TABLE_NAME` | Yes | — | MongoDB database name prefix |
| `REDIS_URL` | Yes | — | Redis connection URL (`rediss://…`) |
| `REDIS_KEY_PREFIX` | No | `thanhfng_server` | Redis key namespace |
| `JWT_SECRET_KEY` | Yes | — | JWT signing secret |
| `EXPRESS_SESSION_SECRET` | Yes | — | Express session secret |
| `GOOGLE_CLIENT_ID` | Yes | — | Google OAuth client ID |
| `PAYPAL_CLIENT_ID` | Yes | — | PayPal API client ID |
| `PAYPAL_CLIENT_SECRET` | Yes | — | PayPal API client secret |
| `PAYPAL_WEBHOOK_ID` | Yes | — | PayPal webhook ID for signature verification |
| `PAYPAL_MODE` | Yes | — | `sandbox` or `live` |
| `FE_ALLOWED_URL` | Yes | — | Frontend origin for CORS |

### Logging

Logs are written as newline-delimited JSON to stdout (pino default). Each entry includes `context` (module name), `level`, `timestamp`, and structured metadata.

```bash
# Pretty-print in local development (no runtime dependency):
LOG_LEVEL=debug yarn dev | npx pino-pretty

# Filter by context in production:
LOG_LEVEL=error yarn start
```

## Changelog

### Sprint 1 — Logic Fixes, Code Quality & Refactoring

- **Error infrastructure:** Typed error classes in `src/lib/errors.ts` replace bare `new Error(msg)` calls across all resolvers.
- **`refreshToken` fix:** Changed from `authorizedWrapper` (required valid access token) to `publicWrapper` + rate limiting. The old wrapper defeated the purpose of token refresh.
- **`userLogout` simplification:** Removed redundant JWT re-verification — `sid` is already decoded by `authenticateUser` into `context.user.sid`.
- **`sortQuery` fix:** Default `createdAt: -1` no longer silently overrides an explicit user-specified sort order.
- **DRY refactoring:**
  - `toItemResponse`, `toOrderResponse`, `toUserPaymentResponse`, `toAdminPaymentResponse` mappers extracted — 6 identical item mappings and multiple payment/order mappings eliminated.
  - `emitPaymentStatus(userId, payload)` extracted to `src/services/socket.ts` — 6 inline `io.to().emit()` blocks consolidated.
  - `getOrCacheUserInfo(userId)` extracted to `src/services/user.ts` — 3 duplicated Redis-first user-info blocks consolidated.
- **COD `transactionId` fix:** PaymentId generated upfront and used as `transactionId` on the Order document, fixing the bug where `transactionId` was `undefined` at order creation time.
- **Redundant `abortTransaction` removed:** `withTransaction` auto-aborts; the manual `session.abortTransaction()` in the catch block was redundant and could throw if the session was already closed.
- **`approveCODPayment` atomicity:** Order and Payment saves are now wrapped in `session.withTransaction()` for DB-level atomicity (the Redis lock provides idempotency; the transaction adds consistency).
- **Order `userId` field:** Added `userId: string` to the Order schema for stable ownership queries. `getUserOrder` uses `userId` with a backward-compatible `$or` fallback for orders created before this migration.
- **Architecture — PayPal handler extraction:** `processWebhookEvent`, `processPaymentCaptureEvent`, and `processCheckoutOrderApproved` moved from `src/helper/paypal.ts` to `src/services/paypal/handler.ts`. The helper now contains only pure type definitions and pure utilities.

### Sprint 2 — Logging System, CVE Fixes & Code Quality

- **CVE fixes:** Bumped `@apollo/server` (4.11.2 → 4.13.0), `axios` (1.13.2 → 1.13.6), `rollup` (4.53.3 → 4.59.0) to resolve known vulnerabilities.
- **Structured logging (pino):** Added `pino` as the logging library. All 74 `console.*` calls across 12 files replaced with structured JSON logs. Each module creates a child logger via `createLogger('ModuleName')` (`src/lib/logger.ts`) — every log entry carries a `context` field for filtering in log aggregation tools.
  - Log level controlled by `LOG_LEVEL` env var (default: `info`). See [Logging](#logging) section above.
  - Error objects passed as `{ err }` to capture stack traces via pino's built-in serializer.
- **`isOk` anti-pattern fix:** Replaced `new Promise` wrapping a `.then()/.catch()` chain with clean `async/await` in `src/lib/index.ts`.
- **`userRegister` transaction:** `UserInfoModel.create` + `UserModel.create` are now wrapped in `session.withTransaction()`. Previously, a failure during `UserModel.create` would leave an orphaned `UserInfoModel` document.
- **Google login transaction:** Same fix applied to the new-user creation path in `userLogin` when signing in via Google for the first time.
- **`userUpdateInfo` partial update fix:** Fields are now only updated if explicitly provided in the request (`!== undefined`). The previous `|| ''` pattern silently cleared existing values when a field was omitted. `null` is treated as an explicit clear (sets the field to `''`).
- **`updateCategory` cache invalidation fix:** Captured the old category name before mutating the document. Previously, `oldCategory.name = name` ran before `categoryDel(oldCategory.name)`, causing the new name to be deleted from cache instead of the old one.
- **ESLint duplicate rule fix:** Removed the `@typescript-eslint/no-unused-vars: 'off'` override in `eslint.config.js` that immediately shadowed the configured rule — unused variables are now correctly caught during builds.