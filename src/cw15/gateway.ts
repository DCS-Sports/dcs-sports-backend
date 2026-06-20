/**
 * CW15 GATEWAY MOUNT — what CW16 imports into src/gateway/server.ts.
 *
 * CW16 usage (replaces the Day-0 vision/talent stub):
 *
 *   import { mountCw15 } from "dcs-sports-cw15/gateway";
 *   mountCw15(app, { queue: bullmqQueue });   // dbFactory auto-derives from env
 *
 * We export the route factory (an Express Router) + a convenience mounter that
 * threads the live Supabase env + queue. No separate server — these routes live
 * in the one deployed gateway.
 */
import type { Express, Router } from "express";
import { buildRouter, type DBFactory, type RouterRunners } from "./routes/cw15";
import type { Queue } from "./lib/queue";
import { InMemoryQueue } from "./lib/queue";
import { InMemoryDB } from "./db/port";
import { SupabaseDB, supabaseConfigFromEnv } from "./db/supabase";
import { bullmqFromEnv } from "./lib/bullmq";

/** Routes this lane owns, for the gateway's route registry / docs. */
export const CW15_ROUTES = [
  "POST /vision/upload-target",
  "POST /vision/jobs",
  "GET /vision/jobs/:id",
  "GET /drills/types",
  "POST /drills",
  "GET /drills/:id",
  "POST /coach-ai/analyze",
  "POST /coach-ai/plan",
  "GET /athletes/:id/talent",
  "GET /athletes/:id/fitness",
  "POST /athletes/:id/fitness",
  "POST /talent/recompute",
  "POST /talent/calibrate",
  "GET /athletes/:id/selection-probability",
  "GET /cw15/validation-gate",
  "POST /selection/backtest",
  "POST /selection/selector",
  "GET /cw15/metrics",
] as const;

/**
 * The URL prefixes CW15 owns. CW16 uses this to confirm no overlap with
 * existing gateway routes (auth, passport, scoring) before mounting. CW15 never
 * defines bare `/athletes/:id` (that's CW10's passport) — only the suffixes
 * listed in CW15_ROUTES (`/talent`, `/fitness`, `/selection-probability`).
 */
export const CW15_OWNED_PREFIXES = [
  "/vision/",
  "/drills",
  "/coach-ai/",
  "/talent/",
  "/selection/",
  "/cw15/",
  "/athletes/:id/talent",
  "/athletes/:id/fitness",
  "/athletes/:id/selection-probability",
] as const;

/**
 * Defensive overlap check for CW16's integrator. Pass the set of route labels
 * already mounted on the gateway; returns any CW15 route that would collide so
 * the integrator gets a clear signal instead of a silent shadow. Empty = safe.
 */
export function findRouteCollisions(existingRoutes: string[]): string[] {
  const existing = new Set(existingRoutes.map((r) => r.trim()));
  return (CW15_ROUTES as readonly string[]).filter((r) => existing.has(r));
}

/** Build the CW15 router with a derived DB factory + queue + optional model runners. */
export function buildCw15Router(opts?: {
  dbFactory?: DBFactory;
  queue?: Queue;
  runners?: RouterRunners;
}): Router {
  const queue = opts?.queue ?? bullmqFromEnv() ?? new InMemoryQueue();
  const factory: DBFactory =
    opts?.dbFactory ??
    ((token) => {
      const cfg = supabaseConfigFromEnv(token);
      return cfg ? new SupabaseDB(cfg) : new InMemoryDB();
    });
  return buildRouter(factory, queue, opts?.runners ?? {});
}

/**
 * Mount CW15 into an existing gateway app. CW16 injects the model runners here
 * to light up Vision V3/V4 + Coach AI:
 *   mountCw15(app, { queue, runners: { visionModelRunner, llmRunner } });
 */
export function mountCw15(app: Express, opts?: {
  dbFactory?: DBFactory;
  queue?: Queue;
  runners?: RouterRunners;
}): void {
  app.use("/", buildCw15Router(opts));
}

export type { RouterRunners } from "./routes/cw15";

// Re-export the acceptance harness so CW16 can wire it into M-S3/M-S4.
export { runCw15Acceptance, type Verdict, type Check } from "./acceptance/runner";
export {
  FIXTURE_ATHLETE,
  FIXTURE_PERFORMANCES,
  FIXTURE_FITNESS,
  EXPECTED_TALENT,
  EXPECTED_VISION_V1,
  EXPECTED_DARK,
} from "./acceptance/fixture";
