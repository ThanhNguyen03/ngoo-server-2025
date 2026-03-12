import EventEmitter from 'events';
import { createLogger } from './logger';

const logger = createLogger('QueueService');

export type TQueuePriority = 'high' | 'normal' | 'low';
export type TQueueJobData<TEvent = Record<string, unknown>> = {
  id: string;
  event: TEvent;
  orderId: string;
  captureId: string;
  attempts: number;
};
export type TQueueJob<TEvent> = TQueueJobData<TEvent> & {
  priority: number;
  addedAt: number;
  scheduledAt?: number;
  cancelled?: boolean;
};

export type TQueueOptions = {
  maxConcurrent?: number;
  maxRetries?: number;
  retryDelay?: number;
  maxRetryDelay?: number;
  stalledTimeout?: number;
  priorityLevels?: Record<TQueuePriority, number>;
};

export class QueueService<TEvent = Record<string, unknown>> extends EventEmitter {
  protected queue: TQueueJob<TEvent>[] = [];

  protected processing = new Map<
    string,
    {
      startedAt: number;
      workerId: number;
      job: TQueueJobData<TEvent>;
    }
  >();

  protected activeWorkers = 0;
  protected isShuttingDown = false;
  protected pendingTimeouts = new Set<NodeJS.Timeout>();
  protected cleanupInterval: NodeJS.Timeout | null = null;

  // Map timeout to jobId to prevent MEMORY LEAK
  protected timeoutMap = new Map<string, NodeJS.Timeout>();
  protected options: Required<TQueueOptions>;

  constructor(options: TQueueOptions = {}) {
    super();
    this.options = {
      maxConcurrent: options.maxConcurrent || 10,
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000, // 1s
      maxRetryDelay: options.maxRetryDelay || 30 * 1000, // 30s
      stalledTimeout: options.stalledTimeout || 30 * 1000, // 30s
      priorityLevels: options.priorityLevels || {
        high: 1,
        normal: 2,
        low: 3,
      },
    };

    // Auto cleanup interval
    this.startCleanupInterval();
  }

  // API
  add(
    event: TEvent,
    orderId: string,
    captureId: string,
    priority: TQueuePriority = 'normal',
  ): string | Promise<string> {
    if (this.isShuttingDown) {
      throw new Error('Queue is shutting down');
    }

    // Prevent duplicate jobId
    const baseId = `job-${captureId || orderId}`;
    let jobId = `${baseId}-${Date.now()}`;
    let counter = 1;

    while (this.has(jobId)) {
      jobId = `${baseId}-${Date.now()}-${counter}`;
      counter++;
    }
    const priorityValue = this.options.priorityLevels[priority];

    this.queue.push({
      id: jobId,
      event,
      orderId,
      captureId,
      attempts: 0,
      priority: priorityValue,
      addedAt: Date.now(),
      cancelled: false,
    });

    this.sortQueue();
    logger.debug({ jobId, queueSize: this.queue.length }, 'Job added');

    this.emit('jobAdded');

    return jobId;
  }

  startWorker(processor: (job: TQueueJobData<TEvent>) => Promise<void>, concurrency?: number): void {
    const workerCount = concurrency || this.options.maxConcurrent;
    logger.info({ workerCount }, 'Starting workers');

    for (let i = 0; i < workerCount; i++) {
      this.spawnWorker(processor, i);
    }
  }

  cancel(jobId: string, forceRemove: boolean = false): boolean {
    // Clear timeout
    this.clearJobTimeout(jobId);

    const queuedJob = this.queue.find((job) => job.id === jobId);
    if (queuedJob) {
      if (forceRemove) {
        const index = this.queue.findIndex((job) => job.id === jobId);
        if (index !== -1) {
          this.queue.splice(index, 1);
          logger.debug({ jobId }, 'Force removed job');
          return true;
        }
      } else {
        queuedJob.cancelled = true;
        logger.debug({ jobId }, 'Job marked as cancelled');
        return true;
      }
    }

    if (this.processing.has(jobId)) {
      logger.debug({ jobId }, 'Job is currently processing, cannot cancel immediately');
      return false;
    }

    logger.debug({ jobId }, 'Job not found for cancellation');
    return false;
  }

  peek(count: number = 10): TQueueJobData<TEvent>[] {
    return this.queue.slice(0, count).map((job) => ({
      id: job.id,
      event: job.event,
      orderId: job.orderId,
      captureId: job.captureId,
      attempts: job.attempts,
    }));
  }

  remove(jobId: string): boolean {
    //  Clear timeout before remove
    this.clearJobTimeout(jobId);

    const index = this.queue.findIndex((job) => job.id === jobId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      logger.debug({ jobId }, 'Job removed from queue');
      return true;
    }
    return false;
  }

  has(jobId: string): boolean {
    return this.queue.some((job) => job.id === jobId) || this.processing.has(jobId);
  }

  getStats() {
    const now = Date.now();
    const stalledJobs = Array.from(this.processing.entries()).filter(
      ([_, info]) => now - info.startedAt > this.options.stalledTimeout,
    ).length;

    const scheduledJobs = this.queue.filter((job) => job.scheduledAt && job.scheduledAt > now).length;
    const cancelledJobs = this.queue.filter((job) => job.cancelled).length;

    return {
      queued: this.queue.length,
      scheduled: scheduledJobs,
      processing: this.processing.size,
      stalled: stalledJobs,
      cancelled: cancelledJobs,
      activeWorkers: this.activeWorkers,
      pendingTimeouts: this.pendingTimeouts.size,
      isShuttingDown: this.isShuttingDown,
      memoryUsage: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
      options: this.options,
    };
  }

  async shutdown(timeoutMs: number = 30000): Promise<void> {
    logger.info({ pendingJobs: this.queue.length }, 'Queue shutting down');
    this.isShuttingDown = true;
    this.removeAllListeners();

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Clear all pending timeouts
    for (const [, timeout] of this.timeoutMap) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(timeout);
    }
    this.timeoutMap.clear();
    this.pendingTimeouts.clear();

    const startTime = Date.now();
    while (this.processing.size > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs) {
        logger.warn({ processingJobs: this.processing.size }, 'Shutdown timeout reached, forcing exit');
        break;
      }
      logger.debug({ processingJobs: this.processing.size }, 'Waiting for jobs to complete...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (this.queue.length > 0) {
      logger.warn({ abandonedJobs: this.queue.length }, 'Jobs abandoned during shutdown');
    }

    logger.info('Queue shutdown complete');
  }

  // PROTECTED METHODS
  protected spawnWorker(processor: (job: TQueueJobData<TEvent>) => Promise<void>, workerId: number): void {
    const worker = async () => {
      logger.debug({ workerId }, 'Worker started');

      while (!this.isShuttingDown) {
        try {
          await this.waitForJob();
          if (this.isShuttingDown) {
            break;
          }

          const job = this.dequeue();
          if (!job) {
            continue;
          }

          // Skip if job is cancelled
          if (job.cancelled) {
            logger.debug({ workerId, jobId: job.id }, 'Skipping cancelled job');
            continue;
          }

          this.activeWorkers++;
          this.processing.set(job.id, {
            startedAt: Date.now(),
            workerId,
            job: {
              id: job.id,
              event: job.event,
              orderId: job.orderId,
              captureId: job.captureId,
              attempts: job.attempts,
            },
          });

          try {
            logger.debug({ workerId, jobId: job.id, attempt: job.attempts + 1 }, 'Processing job');

            // Add timeout to prevent stuck jobs
            await Promise.race([
              processor({
                id: job.id,
                event: job.event,
                orderId: job.orderId,
                captureId: job.captureId,
                attempts: job.attempts,
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error(`Job ${job.id} timeout after 30s`)), 30000)),
            ]);

            logger.debug({ workerId, jobId: job.id }, 'Job completed');
          } catch (error) {
            logger.error({ workerId, jobId: job.id, err: error }, 'Job failed');

            // Handle timeout differently
            const isTimeout = error instanceof Error && error.message.includes('timeout');
            if (isTimeout) {
              job.attempts = 0; // Reset attempts for timeout
            } else {
              job.attempts++;
            }

            if (job.attempts < this.options.maxRetries) {
              const delay = Math.min(this.options.retryDelay * Math.pow(2, job.attempts), this.options.maxRetryDelay);
              this.scheduleRetry(job, delay);

              logger.debug({ jobId: job.id, delayMs: delay }, 'Scheduled retry');
            } else {
              logger.error({ jobId: job.id, maxRetries: this.options.maxRetries }, 'Max retries reached');
              this.emit('jobFailed', { job, error });
            }
          } finally {
            this.activeWorkers--;
            this.processing.delete(job.id);
            this.checkAndNotify();
          }
        } catch (error) {
          logger.error({ workerId, err: error }, 'Worker error');
          if (!this.isShuttingDown) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }

      logger.debug({ workerId }, 'Worker stopped');
    };

    worker().catch((error) => {
      logger.error({ workerId, err: error }, 'Worker fatal error');
    });
  }

  protected async waitForJob(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.isShuttingDown || (this.queue.length > 0 && this.activeWorkers < this.options.maxConcurrent)) {
          resolve();
          return;
        }
        this.once('jobAdded', check);
      };
      check();
    });
  }

  protected dequeue(): TQueueJob<TEvent> | null {
    if (this.queue.length === 0) {
      return null;
    }

    const now = Date.now();
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.queue[i];
      if ((!job.scheduledAt || job.scheduledAt <= now) && !job.cancelled) {
        return this.queue.splice(i, 1)[0];
      }
    }

    return null;
  }

  protected scheduleRetry(job: TQueueJob<TEvent>, delay: number): void {
    // Don't schedule retry if job is cancelled
    if (job.cancelled) {
      logger.debug({ jobId: job.id }, 'Skipping retry for cancelled job');
      return;
    }

    const scheduledAt = Date.now() + delay;
    const retryJob = { ...job, scheduledAt };

    this.queue.push(retryJob);
    this.sortQueue();

    const timeout = setTimeout(() => {
      this.pendingTimeouts.delete(timeout);
      this.timeoutMap.delete(job.id);
      this.emit('jobAdded');
    }, delay);

    this.pendingTimeouts.add(timeout);
    this.timeoutMap.set(job.id, timeout); // Set map timeout to jobId

    logger.debug({ jobId: job.id, delayMs: delay }, 'Retry scheduled');
  }

  protected clearJobTimeout(jobId: string): void {
    const timeout = this.timeoutMap.get(jobId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(timeout);
      this.timeoutMap.delete(jobId);
      logger.debug({ jobId }, 'Cleared job timeout');
    }
  }

  protected sortQueue(): void {
    this.queue.sort((a, b) => {
      // Skip cancelled jobs
      if (a.cancelled && !b.cancelled) return 1;
      if (!a.cancelled && b.cancelled) return -1;

      const aReady = !a.scheduledAt || a.scheduledAt <= Date.now();
      const bReady = !b.scheduledAt || b.scheduledAt <= Date.now();

      if (aReady !== bReady) {
        return aReady ? -1 : 1;
      }
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.addedAt - b.addedAt;
    });
  }

  protected checkAndNotify(): void {
    if (this.queue.length > 0 && this.activeWorkers < this.options.maxConcurrent) {
      this.emit('jobAdded');
    }
  }

  protected startCleanupInterval(): void {
    this.cleanupInterval = setInterval(
      () => {
        if (this.pendingTimeouts.size !== this.timeoutMap.size) {
          logger.debug(
            { pendingTimeouts: this.pendingTimeouts.size, timeoutMapSize: this.timeoutMap.size },
            'Cleaning up orphaned timeouts',
          );
          this.pendingTimeouts.clear();
          for (const [, timeout] of this.timeoutMap) {
            this.pendingTimeouts.add(timeout);
          }
        }
      },
      5 * 60 * 1000,
    ); // 5 mins
  }
}
