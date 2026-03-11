/**
 * Application error class hierarchy.
 *
 * All errors extend `AppError` which itself extends the native `Error` class,
 * so Apollo Server's `formatError` handler catches and processes them normally.
 * Each subclass sets a machine-readable `code` (exposed as `extensions.code`
 * in the GraphQL error response) and an HTTP-equivalent `statusCode` for
 * logging and monitoring purposes.
 *
 * Usage:
 *   throw new NotFoundError('Order not found');
 *   throw new ConflictError('Category already exists');
 */

/**
 * Base application error.
 * All domain-specific errors should extend this class.
 */
export class AppError extends Error {
  /** Machine-readable error code exposed in GraphQL `extensions.code`. */
  readonly code: string;
  /** HTTP-equivalent status code for logging and monitoring. */
  readonly statusCode: number;

  constructor(message: string, code = 'INTERNAL_ERROR', statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;

    // Maintains proper prototype chain in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Resource not found (HTTP 404).
 * Use when a database record or resource does not exist.
 */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 'NOT_FOUND', 404);
  }
}

/**
 * Input validation failure (HTTP 400).
 * Use when request arguments fail business-rule validation beyond
 * what Joi schema validation covers (e.g. cross-field constraints).
 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

/**
 * Authentication failure (HTTP 401).
 * Use when a token is missing, invalid, expired, or revoked.
 */
export class AuthenticationError extends AppError {
  constructor(message: string) {
    super(message, 'AUTHENTICATION_ERROR', 401);
  }
}

/**
 * Authorization failure (HTTP 403).
 * Use when the authenticated user lacks permission for an operation
 * (e.g. non-admin accessing admin-only resolver).
 */
export class AuthorizationError extends AppError {
  constructor(message: string) {
    super(message, 'AUTHORIZATION_ERROR', 403);
  }
}

/**
 * Rate limit exceeded (HTTP 429).
 * Use when token-bucket or sliding-window rate limits are hit.
 */
export class RateLimitError extends AppError {
  constructor(message: string) {
    super(message, 'RATE_LIMIT_ERROR', 429);
  }
}

/**
 * Payment processing failure (HTTP 402).
 * Use for PayPal, COD, or crypto payment errors that are user-actionable.
 */
export class PaymentError extends AppError {
  constructor(message: string) {
    super(message, 'PAYMENT_ERROR', 402);
  }
}

/**
 * Resource conflict (HTTP 409).
 * Use when creating a resource that already exists.
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'CONFLICT_ERROR', 409);
  }
}
