// src/queue/index.ts
// BullMQ job-queue scaffold (reuse the Agentic gateway worker pattern).
// Three lanes: agents (scheduled suggestion writers), alerts, vision (CW15
// hands jobs here). Fails closed if Redis is unconfigured.
import { Queue, ConnectionOptions } from 'bullmq';

export const QUEUE_NAMES = {
  agents: 'sports-agents',
  alerts: 'sports-alerts',
  vision: 'sports-vision',
} as const;

/** Build a BullMQ ConnectionOptions from SPORTS_REDIS_URL. We hand BullMQ a
 *  plain options object (not an IORedis instance) so it uses its own bundled
 *  ioredis — avoids the dual-copy type clash. Fails closed if unset. */
export function getConnection(): ConnectionOptions {
  const url = process.env.SPORTS_REDIS_URL;
  if (!url) {
    throw new Error('[queue] SPORTS_REDIS_URL not set — worker lane refuses to run unconfigured.');
  }
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    username: u.username || undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

const _queues = new Map<string, Queue>();
export function getQueue(name: string): Queue {
  if (_queues.has(name)) return _queues.get(name)!;
  const q = new Queue(name, { connection: getConnection() });
  _queues.set(name, q);
  return q;
}

export async function enqueue(name: string, jobName: string, data: unknown) {
  return getQueue(name).add(jobName, data as object, {
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}
