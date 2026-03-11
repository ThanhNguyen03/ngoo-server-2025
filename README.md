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