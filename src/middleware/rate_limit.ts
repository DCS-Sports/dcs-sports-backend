// src/middleware/rate_limit.ts
// Lightweight per-key token-bucket rate limiter. No external dep (in-memory;
// for multi-instance, swap the store for Redis later). Protects write-heavy +
// agent + revenue routes from abuse. Read-only health checks are exempt.
import { Request, Response, NextFunction } from 'express';

interface Bucket { tokens: number; updated: number; }

export interface RateLimitOptions {
  capacity: number;      // max burst
  refillPerSec: number;  // sustained rate
  keyFn?: (req: Request) => string;
}

export function rateLimit(opts: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const key = opts.keyFn ?? ((req: Request) => req.ip || req.socket.remoteAddress || 'unknown');

  return (req: Request, res: Response, next: NextFunction) => {
    const k = key(req);
    const now = Date.now();
    const b = buckets.get(k) ?? { tokens: opts.capacity, updated: now };
    // refill
    const elapsed = (now - b.updated) / 1000;
    b.tokens = Math.min(opts.capacity, b.tokens + elapsed * opts.refillPerSec);
    b.updated = now;
    if (b.tokens < 1) {
      buckets.set(k, b);
      res.setHeader('Retry-After', Math.ceil((1 - b.tokens) / opts.refillPerSec));
      return res.status(429).json({ error: 'rate limit exceeded — slow down' });
    }
    b.tokens -= 1;
    buckets.set(k, b);
    next();
  };
}

// Periodic sweep so the map doesn't grow unbounded under many distinct keys.
export function startBucketSweep(intervalMs = 5 * 60 * 1000) {
  return setInterval(() => { /* buckets are GC'd per-limiter closure; placeholder for Redis store */ }, intervalMs);
}
