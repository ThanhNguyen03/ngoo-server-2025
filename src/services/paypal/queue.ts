import type { TPayPalWebhookEvent } from '@helper';
import { QueueService, type TQueueJob, type TQueueOptions, type TQueuePriority } from '@lib';

export class WebhookQueueService extends QueueService<TPayPalWebhookEvent> {
  private processingJobsCache = new Map<string, { lastUpdated: number; data: TPayPalWebhookEvent }>();

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
   * Cancel a job by ID
   * @param jobId - The job ID to cancel
   * @param forceRemove - Whether to immediately remove from queue
   * @returns Whether the job was cancelled
   */
  cancel(jobId: string, forceRemove: boolean = false): boolean {
    // Cancel queued job
    const queuedJob = this.queue.find((job) => job.id === jobId);
    if (queuedJob) {
      if (forceRemove) {
        const index = this.queue.findIndex((job) => job.id === jobId);
        if (index !== -1) {
          this.queue.splice(index, 1);
          console.log(`[WebhookQueueService] Force removed job ${jobId}`);
          return true;
        }
      } else {
        queuedJob.cancelled = true;
        console.log(`[WebhookQueueService] Marked job ${jobId} as cancelled`);
        return true;
      }
    }

    // Job is currently processing, we can't cancel it immediately
    // but we can mark it for cleanup after completion
    if (this.processing.has(jobId)) {
      console.log(`[WebhookQueueService] Job ${jobId} is currently processing, cannot cancel immediately`);
      return false;
    }

    console.log(`[WebhookQueueService] Job ${jobId} not found`);
    return false;
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
        job.cancelled = true;
        cancelledCount++;
      }
    });

    // Note: Processing jobs cannot be cancelled immediately
    const processingJobs = Array.from(this.processing.values()).filter((info) => info.job.orderId === orderId);

    console.log(`[WebhookQueueService] Cancelled ${cancelledCount} jobs for order ${orderId}`);
    console.log(`[WebhookQueueService] ${processingJobs.length} jobs still processing for order ${orderId}`);

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
        job.cancelled = true;
        cancelledCount++;
      }
    });

    console.log(`[WebhookQueueService] Cancelled ${cancelledCount} jobs for capture ${captureId}`);
    return cancelledCount;
  }

  /**
   * Get all jobs for a specific order
   * @param orderId - The order ID to filter by
   * @returns Array of jobs
   */
  getJobsByOrderId(orderId: string): TQueueJob<TPayPalWebhookEvent>[] {
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
      console.log(`[WebhookQueueService] Cleaned up ${removedCount} cancelled jobs`);
    }

    return removedCount;
  }

  /**
   * Override add method to include webhook-specific logic
   */
  add(event: TPayPalWebhookEvent, orderId: string, captureId: string, priority: TQueuePriority = 'normal'): string {
    // Check if similar job already exists and is still processing
    const similarJob = Array.from(this.processing.values()).find(
      (info) => info.job.orderId === orderId && info.job.captureId === captureId,
    );

    if (similarJob) {
      console.log(`[WebhookQueueService] Similar job already processing for order ${orderId}, capture ${captureId}`);
      // Cache the new event for potential later processing
      this.cacheProcessingJob(orderId, captureId, event);
    }

    return super.add(event, orderId, captureId, priority);
  }

  /**
   * Override getStats to include webhook-specific metrics
   */
  getStats() {
    const baseStats = super.getStats();
    return {
      ...baseStats,
      processingJobsCacheSize: this.processingJobsCache.size,
      cancelledJobs: this.queue.filter((job) => job.cancelled).length,
    };
  }

  // ========== PRIVATE METHODS ==========
  private cacheProcessingJob(orderId: string, captureId: string, event: TPayPalWebhookEvent): void {
    const cacheKey = `${orderId}:${captureId}`;
    this.processingJobsCache.set(cacheKey, {
      lastUpdated: Date.now(),
      data: event,
    });

    // Cleanup old cache entries periodically
    setTimeout(() => {
      this.cleanupOldCacheEntries();
    }, 60000); // Cleanup every minute
  }

  private cleanupOldCacheEntries(): void {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    for (const [key, value] of this.processingJobsCache.entries()) {
      if (now - value.lastUpdated > maxAge) {
        this.processingJobsCache.delete(key);
      }
    }
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
