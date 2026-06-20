/**
 * BullMQ queue adapter — the real out-of-process queue for deploy.
 *
 * Implements the same Queue port as InMemoryQueue, so the service code is
 * identical in dev and prod. enqueue() adds a job; process() registers a Worker.
 * Used when REDIS_URL is set; otherwise the app falls back to InMemoryQueue.
 *
 * The Worker runs in a separate process (worker/main.ts) in production, but this
 * adapter also supports in-process workers for a single-dyno deploy.
 */
import { Queue as BullQueue, Worker, type ConnectionOptions } from "bullmq";
import type { Queue, Consumer } from "./queue";

export class BullMQQueue implements Queue {
  private queues = new Map<string, BullQueue>();
  private workers: Worker[] = [];
  private connection: ConnectionOptions;

  constructor(redisUrl: string) {
    // BullMQ needs maxRetriesPerRequest: null for blocking commands.
    const url = new URL(redisUrl);
    this.connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username || undefined,
      password: url.password || undefined,
      tls: url.protocol === "rediss:" ? {} : undefined,
      maxRetriesPerRequest: null,
    } as ConnectionOptions;
  }

  private queueFor(name: string): BullQueue {
    let q = this.queues.get(name);
    if (!q) {
      q = new BullQueue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue<T>(name: string, data: T): Promise<void> {
    await this.queueFor(name).add(name, data, {
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
    });
  }

  process<T>(name: string, consumer: Consumer<T>): void {
    const worker = new Worker(
      name,
      async (job) => {
        await consumer({ name, data: job.data as T });
      },
      { connection: this.connection, concurrency: 2 },
    );
    // A failed job is recorded by BullMQ; log but never crash the process.
    worker.on("failed", (job, err) => {
      // eslint-disable-next-line no-console
      console.error(`[bullmq] job ${job?.id} failed:`, err?.message);
    });
    this.workers.push(worker);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/** Build the right queue from env: BullMQ when REDIS_URL set, else null. */
export function bullmqFromEnv(): BullMQQueue | null {
  const url = process.env.REDIS_URL?.trim();
  return url ? new BullMQQueue(url) : null;
}
