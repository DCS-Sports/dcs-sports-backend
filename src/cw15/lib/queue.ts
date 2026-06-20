/**
 * Queue port — BullMQ/Redis pattern (reused from Agentic gateway workers).
 * Redis is DARK in-session, so the in-memory queue runs the consumer inline.
 * At deploy, swap for a real BullMQ Queue/Worker against the provisioned Redis.
 */
export interface QueueJob<T = unknown> {
  name: string;
  data: T;
}

export type Consumer<T = unknown> = (job: QueueJob<T>) => Promise<void>;

export interface Queue {
  enqueue<T>(name: string, data: T): Promise<void>;
  process<T>(name: string, consumer: Consumer<T>): void;
}

/** In-memory queue: processes inline so tests + dev exercise the worker path. */
export class InMemoryQueue implements Queue {
  private consumers = new Map<string, Consumer>();

  process<T>(name: string, consumer: Consumer<T>): void {
    this.consumers.set(name, consumer as Consumer);
  }

  async enqueue<T>(name: string, data: T): Promise<void> {
    const consumer = this.consumers.get(name);
    if (!consumer) return; // no consumer registered yet — job dropped in mock
    // Run inline; real BullMQ would do this out-of-process. A job that throws
    // marks itself failed (in its own handler) but must NOT crash the producer —
    // mirror BullMQ's isolation so callers (e.g. createJob) don't see job errors.
    try {
      await consumer({ name, data });
    } catch {
      /* job failure is recorded by the consumer (status -> failed); swallow here */
    }
  }
}
