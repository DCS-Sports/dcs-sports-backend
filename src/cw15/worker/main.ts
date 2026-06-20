/**
 * CW15 WORKER PROCESS — out-of-process vision worker for production.
 *
 * Run as a separate Railway process: `node dist/worker/main.js`.
 * It connects to Redis (REDIS_URL), consumes the "vision" queue, and processes
 * jobs through the same VisionService used by the API. Writes go via the
 * service-role Supabase client. Vision V3/V4 still fail closed unless a model
 * runner is wired here (kept DARK until DK provisions the CV model).
 *
 * If REDIS_URL is absent the process exits cleanly (nothing to do) rather than
 * crashing — the API falls back to the in-process inline queue in that case.
 */
import { bullmqFromEnv } from "../lib/bullmq";
import { InMemoryDB, type DBPort } from "../db/port";
import { SupabaseDB, supabaseConfigFromEnv } from "../db/supabase";
import { VisionService } from "../services/vision";
import { DrillService } from "../services/drill";
import { TalentRecomputeService } from "../services/talent-recompute";

function makeDb(): DBPort {
  const cfg = supabaseConfigFromEnv();
  return cfg ? new SupabaseDB(cfg) : new InMemoryDB();
}

async function main() {
  const queue = bullmqFromEnv();
  if (!queue) {
    // eslint-disable-next-line no-console
    console.log("[cw15-worker] REDIS_URL not set — no out-of-process worker needed.");
    return;
  }
  const db = makeDb();
  // No model runner here yet → V3/V4 fail closed (honest-scope). Inject when ready.
  const vision = new VisionService(db, queue);
  queue.process<{ jobId: string }>("vision", async (job) => {
    await vision.process(job.data.jobId);
  });

  // aiScout drill worker — no model runner yet → timed drills fail closed.
  const drill = new DrillService(db, queue);
  queue.process<{ jobId: string }>("drill", async (job) => {
    await drill.process(job.data.jobId);
  });

  // Talent v2 nightly recompute — enqueue "talent-recompute" jobs (e.g. via a
  // cron/scheduler) and this consumer reprocesses scores as match data grows.
  const recompute = new TalentRecomputeService(db);
  queue.process<{ limit?: number }>("talent-recompute", async (job) => {
    const result = await recompute.recomputeAll({ limit: job.data?.limit });
    // eslint-disable-next-line no-console
    console.log(`[cw15-worker] talent recompute: ${result.recomputed}/${result.total} in ${result.duration_ms}ms`);
  });
  // eslint-disable-next-line no-console
  console.log("[cw15-worker] vision worker up, consuming the 'vision' queue.");

  const shutdown = async () => {
    // eslint-disable-next-line no-console
    console.log("[cw15-worker] shutting down…");
    await queue.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[cw15-worker] fatal:", e);
  process.exit(1);
});
