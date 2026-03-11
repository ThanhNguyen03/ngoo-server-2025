import { RedisHelper, type TPayPalWebhookEvent } from '@helper';
import { createLogger, QueueService, type TQueueJobData, type TQueueOptions, type TQueuePriority } from '@lib';

const logger = createLogger('WebhookQueue');

export class WebhookQueueService extends QueueService<TPayPalWebhookEvent> {
  private processingJobs = new Set<string>();

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

        // Auto cleanup sau 5 phút
        setTimeout(
          () => {
            this.processingJobs.delete(jobKey);
          },
          5 * 60 * 1000,
        );

        return super.add(event, orderId, captureId, priority);
      });
      return result;
    } catch (error) {
      // Lock failed — continue without lock, in-memory dedup still protects against duplicates
      logger.warn({ orderId, err: error }, 'Webhook lock failed, continuing without lock');

      // Track job in memory
      this.processingJobs.add(jobKey);
      setTimeout(
        () => {
          this.processingJobs.delete(jobKey);
        },
        5 * 60 * 1000,
      );

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
        this['clearJobTimeout'](job.id);
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
        this['clearJobTimeout'](job.id);
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
  maxConcurrent: 10,
  maxRetries: 3,
  retryDelay: 1000,
  maxRetryDelay: 30 * 1000, // 30s
  stalledTimeout: 60 * 1000, // 1 minute
});
