import { RedisInstance } from './redis';

export type TQueuePiority = 'high' | 'normal' | 'low';

const BLOCK_TIMEOUT = 10; // 10ms
const TTL_JOB_TIME = 30 * 60; // 30 minutes
const TTL_DEAD_LETTER_TIME = 7 * 24 * 60 * 60; // 7days
const TTL_RETRY_QUEUE_TIME = 1 * 24 * 60 * 60; // 1day
const MAX_RETRY_DELAY_TIME = 30 * 1000; // 30s
export class RedisQueueService {
  private queueKey: string;
  private processingKey: string;
  private retryKey: string;
  private deadLetterKey: string;
  private activeWorkers: Set<Promise<void>> = new Set();
  private isShuttingDown = false;

  constructor(queueName: string = 'paypal-webhook') {
    const prefix = RedisInstance.prefixValue;
    this.queueKey = `${prefix}:queue:${queueName}`;
    this.processingKey = `${prefix}:queue:${queueName}:processing`;
    this.retryKey = `${prefix}:queue:${queueName}:retry`;
    this.deadLetterKey = `${prefix}:queue:${queueName}:dead`;
  }

  // ===== CORE QUEUE OPERATIONS =====
  async enqueue<T>(jobId: string, data: T, priority: TQueuePiority = 'normal'): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error('Queue is shutting down');
    }

    const job = {
      id: jobId,
      data,
      createdAt: Date.now(),
      attempts: 0,
      priority: this.getPriorityValue(priority),
    };

    // Using RPUSH to force FIFO
    await RedisInstance.redis.rPush(this.queueKey, JSON.stringify(job));
    console.log(`[RedisQueue] Enqueued job ${jobId} with priority ${priority}`);
  }

  async dequeue<T>(): Promise<{ id: string; data: T; attempts: number } | null> {
    if (this.isShuttingDown) {
      return null;
    }

    try {
      // BRPOP with timeout to prevent block forever
      const result = await RedisInstance.redis.brPop(this.queueKey, BLOCK_TIMEOUT);

      if (!result) {
        return null; // Timeout, return null to worker continue loop
      }

      const job = JSON.parse(result.element);

      // Save into processing set with TTL
      await RedisInstance.redis.hSet(
        this.processingKey,
        job.id,
        JSON.stringify({
          ...job,
          startedAt: Date.now(),
        }),
      );

      // Set TTL for processing job
      await RedisInstance.redis.expire(this.processingKey, TTL_JOB_TIME);

      console.log(`[RedisQueue] Dequeued job ${job.id}, attempt ${job.attempts + 1}`);
      return job;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Connection')) {
        console.error('[RedisQueue] Redis connection error during dequeue');
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1s before retry
      }
      throw error;
    }
  }

  async complete(jobId: string): Promise<void> {
    await RedisInstance.redis.hDel(this.processingKey, jobId);
    console.log(`[RedisQueue] Completed job ${jobId}`);
  }

  async fail(jobId: string, error: Error, maxRetries: number = 3): Promise<void> {
    const jobStr = await RedisInstance.redis.hGet(this.processingKey, jobId);
    if (!jobStr) {
      console.warn(`[RedisQueue] Job ${jobId} not found in processing`);
      return;
    }

    const job = JSON.parse(jobStr);
    job.attempts = (job.attempts || 0) + 1;
    job.lastError = error.message;
    job.lastFailedAt = Date.now();

    console.log(`[RedisQueue] Job ${jobId} failed, attempt ${job.attempts}/${maxRetries}`);

    if (job.attempts >= maxRetries) {
      // Move to dead letter
      await RedisInstance.redis.lPush(
        this.deadLetterKey,
        JSON.stringify({
          ...job,
          failedAt: Date.now(),
          reason: 'Max retries exceeded',
          finalError: error.message,
        }),
      );

      // Set TTL for dead letter
      await RedisInstance.redis.expire(this.deadLetterKey, TTL_DEAD_LETTER_TIME);

      console.log(`[RedisQueue] Moved job ${jobId} to dead letter`);
    } else {
      // Retry with exponential backoff
      const delay = Math.min(Math.pow(2, job.attempts) * 1000, MAX_RETRY_DELAY_TIME); // Max 30s
      const retryJob = {
        ...job,
        retryAt: Date.now() + delay,
      };

      await RedisInstance.redis.zAdd(this.retryKey, {
        score: retryJob.retryAt,
        value: JSON.stringify(retryJob),
      });

      // Set TTL for retry queue
      await RedisInstance.redis.expire(this.retryKey, TTL_RETRY_QUEUE_TIME);

      console.log(`[RedisQueue] Scheduled retry for job ${jobId} in ${delay}ms`);
    }

    // Delete from processing
    await RedisInstance.redis.hDel(this.processingKey, jobId);
  }

  // ===== WORKER MANAGEMENT =====
  async startWorker<T>(
    processor: (data: T, metadata: { jobId: string; attempts: number }) => Promise<void>,
    concurrency: number = 5,
    options: {
      pollingTime?: number;
      recoverStalled?: boolean;
      stalledTimeout?: number;
    } = {},
  ): Promise<void> {
    const { pollingTime = 5000, recoverStalled = true, stalledTimeout = 30000 } = options;

    console.log(`[RedisQueue] Starting ${concurrency} workers`);

    // Init retry processor
    this.startRetryProcessor(pollingTime);

    //Init stalled job recovery if enabled
    if (recoverStalled) {
      this.startStalledJobRecovery(stalledTimeout, pollingTime * 2);
    }

    // Init workers
    for (let i = 0; i < concurrency; i++) {
      const workerPromise = this.workerLoop(processor, i);
      this.activeWorkers.add(workerPromise);

      // Remove from set when worker is off
      workerPromise.finally(() => {
        this.activeWorkers.delete(workerPromise);
      });
    }
  }

  private async workerLoop<T>(
    processor: (data: T, metadata: { jobId: string; attempts: number }) => Promise<void>,
    workerId: number,
  ): Promise<void> {
    console.log(`[RedisQueue-W${workerId}] Worker started`);

    while (!this.isShuttingDown) {
      try {
        const job = await this.dequeue<T>();

        if (!job) {
          // No job available, small delay to prevent CPU spin
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }

        try {
          console.log(`[RedisQueue-W${workerId}] Processing job ${job.id}`);
          await processor(job.data, { jobId: job.id, attempts: job.attempts });
          await this.complete(job.id);
        } catch (error) {
          console.error(`[RedisQueue-W${workerId}] Job ${job.id} failed:`, error);
          await this.fail(job.id, error as Error);
        }
      } catch (error) {
        console.error(`[RedisQueue-W${workerId}] Worker error:`, error);

        if (!this.isShuttingDown) {
          // Wait before retry, with exponential backoff for worker errors
          const delay = error instanceof Error && error.message.includes('Connection') ? 5000 : 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    console.log(`[RedisQueue-W${workerId}] Worker stopped`);
  }

  private startRetryProcessor(pollingTime: number = 5000): NodeJS.Timeout {
    return setInterval(async () => {
      try {
        const now = Date.now();

        // Get jobs are retry, LIMIT to prevent memory spike
        const jobs = await RedisInstance.redis.zRangeByScore(this.retryKey, 0, now, {
          LIMIT: { offset: 0, count: 100 },
        });

        for (const jobStr of jobs) {
          try {
            const job = JSON.parse(jobStr);

            // Atomic: Delete from retry set before adding into queue
            const removed = await RedisInstance.redis.zRem(this.retryKey, jobStr);
            if (removed > 0) {
              // Adding agian to main queue
              await this.enqueue(job.id, job.data, this.getPriorityFromValue(job.priority));
              console.log(`[RedisQueue] Retried job ${job.id}`);
            }
          } catch (parseError) {
            console.error('[RedisQueue] Error parsing retry job:', parseError);
            // Still remove invalid job form retry queue
            await RedisInstance.redis.zRem(this.retryKey, jobStr);
          }
        }
      } catch (error) {
        console.error('[RedisQueue] Retry processor error:', error);
      }
    }, pollingTime);
  }

  private startStalledJobRecovery(timeoutMs: number = 30000, pollingTime: number = 10000): NodeJS.Timeout {
    return setInterval(async () => {
      try {
        const processingJobs = await RedisInstance.redis.hGetAll(this.processingKey);
        const now = Date.now();

        for (const [jobId, jobStr] of Object.entries(processingJobs)) {
          try {
            const job = JSON.parse(jobStr);

            if (now - job.startedAt > timeoutMs) {
              console.warn(`[RedisQueue] Job ${jobId} stalled for ${now - job.startedAt}ms, recovering`);

              // Delete job from processing
              await RedisInstance.redis.hDel(this.processingKey, jobId);

              // Adding again into queue with high priority
              await this.enqueue(job.id, job.data, 'high');
            }
          } catch (parseError) {
            console.error('[RedisQueue] Error parsing stalled job:', parseError);
            // Delete invalid job
            await RedisInstance.redis.hDel(this.processingKey, jobId);
          }
        }
      } catch (error) {
        console.error('[RedisQueue] Stalled job recovery error:', error);
      }
    }, pollingTime);
  }

  // ===== UTILITIES =====
  // eslint-disable-next-line class-methods-use-this
  private getPriorityValue(priority: TQueuePiority): number {
    switch (priority) {
      case 'high':
        return 1;
      case 'low':
        return 3;
      default:
        return 2;
    }
  }

  // eslint-disable-next-line class-methods-use-this
  private getPriorityFromValue(value: number): TQueuePiority {
    switch (value) {
      case 1:
        return 'high';
      case 3:
        return 'low';
      default:
        return 'normal';
    }
  }

  async getStats(): Promise<{
    queueLength: number;
    processingCount: number;
    retryCount: number;
    deadLetterCount: number;
    activeWorkers: number;
    timestamp: number;
  }> {
    const [queueLength, processingCount, retryCount, deadLetterCount] = await Promise.all([
      RedisInstance.redis.lLen(this.queueKey),
      RedisInstance.redis.hLen(this.processingKey),
      RedisInstance.redis.zCard(this.retryKey),
      RedisInstance.redis.lLen(this.deadLetterKey),
    ]);

    return {
      queueLength,
      processingCount,
      retryCount,
      deadLetterCount,
      activeWorkers: this.activeWorkers.size,
      timestamp: Date.now(),
    };
  }

  async clear(): Promise<void> {
    await Promise.all([
      RedisInstance.redis.del(this.queueKey),
      RedisInstance.redis.del(this.processingKey),
      RedisInstance.redis.del(this.retryKey),
      RedisInstance.redis.del(this.deadLetterKey),
    ]);
    console.log('[RedisQueue] Cleared all queues');
  }

  async shutdown(timeoutMs: number = 30000): Promise<void> {
    console.log('[RedisQueue] Shutting down...');
    this.isShuttingDown = true;

    // Await workers complete
    const shutdownPromise = Promise.allSettled(Array.from(this.activeWorkers));

    // Timeout to not waiting to long
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Shutdown timeout')), timeoutMs);
    });

    try {
      await Promise.race([shutdownPromise, timeoutPromise]);
      console.log('[RedisQueue] All workers stopped');
    } catch (error) {
      console.warn('[RedisQueue] Some workers did not stop gracefully:', error);
    }
  }
}
