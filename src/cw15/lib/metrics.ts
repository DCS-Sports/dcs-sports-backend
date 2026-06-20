/**
 * CW15 observability — a tiny in-process metrics collector (no deps).
 *
 * Tracks request counts/latency per route, plus domain events (vision jobs by
 * status, talent recomputes, model-unavailable fail-closed hits). Exposed via
 * GET /cw15/metrics for CW16's monitoring/status page to scrape. Also emits a
 * structured one-line JSON log per request for log aggregation.
 *
 * Deliberately in-memory + per-process: cheap, safe, and resets on deploy.
 * Not a replacement for CW16's platform metrics — a per-lane feed into them.
 */

interface Histo {
  count: number;
  sum_ms: number;
  max_ms: number;
  // coarse buckets (ms) for a p50/p95-ish read without storing every sample
  buckets: number[]; // counts for [<=50, <=200, <=1000, <=5000, >5000]
}

const BUCKET_BOUNDS = [50, 200, 1000, 5000];

function emptyHisto(): Histo {
  return { count: 0, sum_ms: 0, max_ms: 0, buckets: [0, 0, 0, 0, 0] };
}

function observe(h: Histo, ms: number) {
  h.count++;
  h.sum_ms += ms;
  if (ms > h.max_ms) h.max_ms = ms;
  let i = BUCKET_BOUNDS.findIndex((b) => ms <= b);
  if (i === -1) i = BUCKET_BOUNDS.length;
  h.buckets[i]++;
}

export class Metrics {
  private startedAt = Date.now();
  private routes = new Map<string, Histo>(); // key: "METHOD /path"
  private counters = new Map<string, number>();

  /** Record a finished HTTP request. */
  recordRequest(method: string, routeLabel: string, statusCode: number, ms: number) {
    const key = `${method} ${routeLabel}`;
    let h = this.routes.get(key);
    if (!h) { h = emptyHisto(); this.routes.set(key, h); }
    observe(h, ms);
    this.inc(`http_status_${Math.floor(statusCode / 100)}xx`);
  }

  /** Increment a named counter (e.g. vision_job_done, model_unavailable). */
  inc(name: string, by = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  snapshot() {
    const routes: Record<string, unknown> = {};
    for (const [key, h] of this.routes) {
      routes[key] = {
        count: h.count,
        avg_ms: h.count ? Math.round(h.sum_ms / h.count) : 0,
        max_ms: Math.round(h.max_ms),
        buckets: { "<=50ms": h.buckets[0], "<=200ms": h.buckets[1], "<=1s": h.buckets[2], "<=5s": h.buckets[3], ">5s": h.buckets[4] },
      };
    }
    return {
      lane: "CW15",
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
      counters: Object.fromEntries(this.counters),
      routes,
    };
  }
}

/** Shared singleton for the lane. */
export const metrics = new Metrics();

/** Structured one-line JSON request log (for log aggregation). */
export function logRequest(entry: {
  method: string;
  path: string;
  status: number;
  ms: number;
}) {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      lane: "CW15",
      lvl: entry.status >= 500 ? "error" : entry.status >= 400 ? "warn" : "info",
      ...entry,
    }),
  );
}
