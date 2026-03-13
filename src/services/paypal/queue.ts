import { config, RedisHelper, type TPayPalWebhookEvent } from '@helper';
import { createLogger, QueueService, type TQueueJobData, type TQueueOptions, type TQueuePriority } from '@lib';

const logger = createLogger('WebhookQueue');

export class WebhookQueueService extends QueueService<TPayPalWebhookEvent> {
  private processingJobs = new Set<string>();
  private cleanupTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(options: TQueueOptions = {}) {
    super({
      maxConcurrent: options.maxConcurrent || 10,
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      maxRetryDelay: options.maxRetryDelay || 30 * 1000,
      stalledTimeout: options.stalledTimeout || 60 * 1000,
      priorityLevels: options.priorityLevels || {
        high: 1,
        normal: 2,
        low: 3,
      },
    });
  }

  // ========== ENHANCED PUBLIC API ==========

  /**
   * Override add method to include webhook-specific logic
   */
  async add(
    event: TPayPalWebhookEvent,
    orderId: string,
    captureId: string,
    priority: TQueuePriority = 'normal',
  ): Promise<string> {
    const jobKey = `${orderId}:${captureId}`;

    // Check in-memory set first — fast dedup before acquiring lock
    if (this.processingJobs.has(jobKey)) {
      logger.debug({ orderId }, 'Duplicate webhook detected, skipping');
      return `duplicate-${orderId}`;
    }

    const lockKey = `webhook:lock:${orderId}:${captureId}`;

    try {
      // Lock with short timeout
      const result = await RedisHelper.lock.withLock(lockKey, 1000, async () => {
        // Double-check
        if (this.processingJobs.has(jobKey)) {
          return `duplicate-${orderId}`;
        }

        // Mark as processing
        this.processingJobs.add(jobKey);

        // Auto cleanup after 5 minutes
        const existingTimeout = this.cleanupTimeouts.get(jobKey);
        if (existingTimeout) clearTimeout(existingTimeout);

        const timeout = setTimeout(
          () => {
            this.processingJobs.delete(jobKey);
            this.cleanupTimeouts.delete(jobKey);
          },
          5 * 60 * 1000,
        );
        this.cleanupTimeouts.set(jobKey, timeout);

        return super.add(event, orderId, captureId, priority);
      });
      return result;
    } catch (error) {
      // Lock failed — continue without lock, in-memory dedup still protects against duplicates
      logger.warn({ orderId, err: error }, 'Webhook lock failed, continuing without lock');

      // Track job in memory
      this.processingJobs.add(jobKey);

      const existingTimeout = this.cleanupTimeouts.get(jobKey);
      if (existingTimeout) clearTimeout(existingTimeout);

      const timeout = setTimeout(
        () => {
          this.processingJobs.delete(jobKey);
          this.cleanupTimeouts.delete(jobKey);
        },
        5 * 60 * 1000,
      );
      this.cleanupTimeouts.set(jobKey, timeout);

      return super.add(event, orderId, captureId, priority);
    }
  }

  /**
   * Cancel all jobs for a specific order
   * @param orderId - The order ID to cancel jobs for
   * @returns Number of jobs cancelled
   */
  cancelByOrderId(orderId: string): number {
    let cancelledCount = 0;

    // Cancel queued jobs
    this.queue.forEach((job) => {
      if (job.orderId === orderId && !job.cancelled) {
        this.clearJobTimeout(job.id);
        job.cancelled = true;
        cancelledCount++;
      }
    });

    // Note: Processing jobs cannot be cancelled immediately
    const processingJobs = Array.from(this.processing.values()).filter((info) => info.job.orderId === orderId);

    logger.info({ orderId, cancelledCount, processingCount: processingJobs.length }, 'Jobs cancelled for order');

    return cancelledCount;
  }

  /**
   * Cancel all jobs for a specific capture ID
   * @param captureId - The capture ID to cancel jobs for
   * @returns Number of jobs cancelled
   */
  cancelByCaptureId(captureId: string): number {
    let cancelledCount = 0;

    // Cancel queued jobs
    this.queue.forEach((job) => {
      if (job.captureId === captureId && !job.cancelled) {
        this.clearJobTimeout(job.id);
        job.cancelled = true;
        cancelledCount++;
      }
    });

    logger.info({ captureId, cancelledCount }, 'Jobs cancelled for capture');
    return cancelledCount;
  }

  /**
   * Get all jobs for a specific order
   * @param orderId - The order ID to filter by
   * @returns Array of jobs
   */
  getJobsByOrderId(orderId: string): TQueueJobData<TPayPalWebhookEvent>[] {
    const queuedJobs = this.queue
      .filter((job) => job.orderId === orderId)
      .map((job) => ({
        id: job.id,
        event: job.event,
        orderId: job.orderId,
        captureId: job.captureId,
        attempts: job.attempts,
      }));

    const processingJobs = Array.from(this.processing.values())
      .filter((info) => info.job.orderId === orderId)
      .map((info) => info.job);

    return [...queuedJobs, ...processingJobs];
  }

  /**
   * Clean up cancelled jobs from queue
   * @returns Number of jobs removed
   */
  cleanupCancelledJobs(): number {
    const initialLength = this.queue.length;
    this.queue = this.queue.filter((job) => !job.cancelled);
    const removedCount = initialLength - this.queue.length;

    if (removedCount > 0) {
      logger.debug({ removedCount }, 'Cleaned up cancelled jobs');
    }

    return removedCount;
  }

  async shutdown(timeoutMs?: number): Promise<void> {
    for (const [, timeout] of this.cleanupTimeouts) {
      clearTimeout(timeout);
    }
    this.cleanupTimeouts.clear();
    this.processingJobs.clear();
    await super.shutdown(timeoutMs);
  }

  /**
   * Override getStats to include webhook-specific metrics
   */
  getStats() {
    const baseStats = super.getStats();
    return {
      ...baseStats,
      processingJobsSize: this.processingJobs.size,
      cancelledJobs: this.queue.filter((job) => job.cancelled).length,
    };
  }
}

// Singleton for PayPal webhooks queue
export const paypalQueueService = new WebhookQueueService({
  maxConcurrent: config.QUEUE_MAX_CONCURRENT,
  maxRetries: config.QUEUE_MAX_RETRIES,
  retryDelay: config.QUEUE_RETRY_DELAY_MS,
  maxRetryDelay: config.QUEUE_MAX_RETRY_DELAY_MS,
  stalledTimeout: config.QUEUE_STALLED_TIMEOUT_MS,
});
