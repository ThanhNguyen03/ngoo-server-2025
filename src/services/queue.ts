// memory-queue.ts
import EventEmitter from 'events';

export type TQueuePriority = 'high' | 'normal' | 'low';
export type TQueueJob = {
  id: string;
  event: Record<string, unknown>;
  orderId: string;
  captureId: string;
  attempts: number;
};

type TQueueOptions = {
  maxConcurrent?: number;
  maxRetries?: number;
  retryDelay?: number;
  maxRetryDelay?: number;
  stalledTimeout?: number;
  priorityLevels?: Record<TQueuePriority, number>;
};

export class QueueService extends EventEmitter {
  private queue: Array<{
    id: string;
    event: any;
    orderId: string;
    captureId: string;
    attempts: number;
    priority: number;
    addedAt: number;
    scheduledAt?: number;
  }> = [];

  private processing = new Map<
    string,
    {
      startedAt: number;
      workerId: number;
    }
  >();

  private activeWorkers = 0;
  private isShuttingDown = false;
  private pendingTimeouts = new Set<NodeJS.Timeout>();

  private options: Required<TQueueOptions>;

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
  }

  // ========== PUBLIC API ==========

  add(event: Record<string, unknown>, orderId: string, captureId: string, priority: TQueuePriority = 'normal'): string {
    if (this.isShuttingDown) {
      throw new Error('Queue is shutting down');
    }

    // Prevent duplicate jobId
    const baseId = `paypal-${captureId || orderId}`;
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
    });

    this.sortQueue();
    console.log(`[MemoryQueue] Added job ${jobId}, queue size: ${this.queue.length}`);

    this.emit('jobAdded');

    return jobId;
  }

  startWorker(processor: (job: TQueueJob) => Promise<void>, concurrency?: number): void {
    const workerCount = concurrency || this.options.maxConcurrent;
    console.log(`[MemoryQueue] Starting ${workerCount} workers`);

    for (let i = 0; i < workerCount; i++) {
      this.spawnWorker(processor, i);
    }
  }

  peek(count: number = 10): TQueueJob[] {
    return this.queue.slice(0, count).map((job) => ({
      id: job.id,
      event: job.event,
      orderId: job.orderId,
      captureId: job.captureId,
      attempts: job.attempts,
    }));
  }

  remove(jobId: string): boolean {
    const index = this.queue.findIndex((job) => job.id === jobId);
    if (index !== -1) {
      this.queue.splice(index, 1);
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

    return {
      queued: this.queue.length,
      scheduled: scheduledJobs,
      processing: this.processing.size,
      stalled: stalledJobs,
      activeWorkers: this.activeWorkers,
      pendingTimeouts: this.pendingTimeouts.size,
      isShuttingDown: this.isShuttingDown,
      memoryUsage: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
      options: this.options,
    };
  }

  async shutdown(timeoutMs: number = 30000): Promise<void> {
    console.log(`[MemoryQueue] Shutting down, ${this.queue.length} jobs pending`);
    this.isShuttingDown = true;
    this.removeAllListeners();

    for (const timeout of this.pendingTimeouts) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();

    const startTime = Date.now();
    while (this.processing.size > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs) {
        console.warn(`[MemoryQueue] Shutdown timeout, ${this.processing.size} jobs still processing`);
        break;
      }
      console.log(`[MemoryQueue] Waiting for ${this.processing.size} jobs...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (this.queue.length > 0) {
      console.warn(`[MemoryQueue] ${this.queue.length} jobs abandoned`);
    }

    console.log('[MemoryQueue] Shutdown complete');
  }

  // ========== PRIVATE METHODS ==========
  private spawnWorker(processor: (job: TQueueJob) => Promise<void>, workerId: number): void {
    const worker = async () => {
      console.log(`[MemoryQueue-W${workerId}] Started`);

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

          this.activeWorkers++;
          this.processing.set(job.id, {
            startedAt: Date.now(),
            workerId,
          });

          try {
            console.log(`[MemoryQueue-W${workerId}] Processing ${job.id}, attempt ${job.attempts + 1}`);

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

            console.log(`[MemoryQueue-W${workerId}] Completed ${job.id}`);
          } catch (error) {
            console.error(`[MemoryQueue-W${workerId}] Failed ${job.id}:`, error);

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

              console.log(`[MemoryQueue] Scheduled retry for ${job.id} in ${delay}ms`);
            } else {
              console.error(`[MemoryQueue] Max retries for ${job.id}`);
              this.emit('jobFailed', { job, error });
            }
          } finally {
            this.activeWorkers--;
            this.processing.delete(job.id);
            this.checkAndNotify();
          }
        } catch (error) {
          console.error(`[MemoryQueue-W${workerId}] Worker error:`, error);
          if (!this.isShuttingDown) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }

      console.log(`[MemoryQueue-W${workerId}] Stopped`);
    };

    worker().catch((error) => {
      console.error(`[MemoryQueue-W${workerId}] Fatal error:`, error);
    });
  }

  private async waitForJob(): Promise<void> {
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

  private dequeue(): any | null {
    if (this.queue.length === 0) return null;

    const now = Date.now();
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.queue[i];
      if (!job.scheduledAt || job.scheduledAt <= now) {
        return this.queue.splice(i, 1)[0];
      }
    }

    return null;
  }

  private scheduleRetry(job: any, delay: number): void {
    const scheduledAt = Date.now() + delay;
    const retryJob = { ...job, scheduledAt };

    this.queue.push(retryJob);
    this.sortQueue();

    const timeout = setTimeout(() => {
      this.pendingTimeouts.delete(timeout);
      this.emit('jobAdded');
    }, delay);

    this.pendingTimeouts.add(timeout);
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
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

  private checkAndNotify(): void {
    if (this.queue.length > 0 && this.activeWorkers < this.options.maxConcurrent) {
      this.emit('jobAdded');
    }
  }
}

// Singleton for PayPal webhooks queue
export const paypalQueueService = new QueueService({
  maxConcurrent: 10,
  maxRetries: 3,
  retryDelay: 1000,
  maxRetryDelay: 30 * 1000, // 30s
  stalledTimeout: 60 * 1000, // 1 minute
});
