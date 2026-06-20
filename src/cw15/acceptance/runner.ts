/**
 * CW15 ACCEPTANCE RUNNER — CW16 calls this from the M-S3 / M-S4 harness.
 *
 * Self-contained: seeds the fixture into an in-memory DB, exercises the real
 * services, and returns a structured verdict. No live infra required, so the
 * gate is deterministic. CW16 can also run the same checks against live Supabase
 * by passing a SupabaseDB — the assertions are backend-agnostic.
 *
 * Verifies:
 *  M-S3  Vision V1 produces a highlight (heuristic, honestly labeled).
 *  M-S4  Talent Index computes an estimate (model_version:null, estimate:true);
 *        DARK paths (Vision V3, Coach AI) FAIL CLOSED — no fabricated output.
 */
import { InMemoryDB, type DBPort } from "../db/port";
import { InMemoryQueue } from "../lib/queue";
import { VisionService } from "../services/vision";
import { TalentService } from "../services/talent";
import { PerformanceLabService } from "../services/performance-lab";
import { CoachAIService } from "../services/coach-ai";
import { ModelUnavailableError } from "../lib/estimate";
import {
  FIXTURE_ATHLETE,
  FIXTURE_PERFORMANCES,
  FIXTURE_FITNESS,
  EXPECTED_VISION_V1,
  EXPECTED_DARK,
} from "./fixture";

export interface Check {
  gate: "M-S3" | "M-S4";
  name: string;
  pass: boolean;
  detail: string;
}

export interface Verdict {
  lane: "CW15";
  green: boolean;
  checks: Check[];
}

export async function runCw15Acceptance(opts?: { db?: DBPort }): Promise<Verdict> {
  // Ensure DARK gates are actually off for the honest-scope checks.
  delete process.env.DCS_VISION_MODEL_URL;
  delete process.env.DCS_LLM_ENDPOINT;

  const seeded = !opts?.db;
  const db = opts?.db ?? new InMemoryDB();
  if (seeded && db instanceof InMemoryDB) db._seedPerformances(FIXTURE_PERFORMANCES);

  const queue = new InMemoryQueue();
  const vision = new VisionService(db, queue);
  queue.process<{ jobId: string }>("vision", async (j) => vision.process(j.data.jobId));

  const checks: Check[] = [];

  // ---- M-S3: Vision V1 highlight ----
  try {
    const job = await vision.createJob({ video_url: "https://r2.example/fixture.mp4", version: "V1" });
    const got = await vision.getJob(job.id);
    const types = (got?.outputs ?? []).map((o) => o.type);
    const hasHighlight = types.includes("highlight");
    const maxConf = Math.max(0, ...(got?.outputs ?? []).map((o) => o.confidence));
    checks.push({
      gate: "M-S3",
      name: "Vision V1 produces a highlight",
      pass: got?.job.status === EXPECTED_VISION_V1.job_status && hasHighlight,
      detail: `status=${got?.job.status} types=[${types.join(",")}]`,
    });
    checks.push({
      gate: "M-S3",
      name: "Vision V1 honestly heuristic (confidence capped low)",
      pass: maxConf <= EXPECTED_VISION_V1.max_confidence,
      detail: `max_confidence=${maxConf} (<= ${EXPECTED_VISION_V1.max_confidence})`,
    });
  } catch (e) {
    checks.push({ gate: "M-S3", name: "Vision V1 produces a highlight", pass: false, detail: String(e) });
  }

  // ---- M-S4: Talent Index estimate ----
  try {
    const lab = new PerformanceLabService(db);
    void lab; // fitness summary optional here; we pass fixture scores directly
    const talent = new TalentService(db);
    const r = await talent.compute(FIXTURE_ATHLETE, FIXTURE_FITNESS);
    checks.push({
      gate: "M-S4",
      name: "Talent Index computes from real performances",
      pass: r.sample_size === FIXTURE_PERFORMANCES.length && r.composite.value > 0,
      detail: `sample_size=${r.sample_size} value=${r.composite.value}`,
    });
    checks.push({
      gate: "M-S4",
      name: "Talent output is an honest estimate (estimate:true, model_version:null)",
      pass: r.composite.estimate === true && r.composite.model_version === null && r.composite.source === "talent",
      detail: `estimate=${r.composite.estimate} model=${r.composite.model_version} source=${r.composite.source}`,
    });
  } catch (e) {
    checks.push({ gate: "M-S4", name: "Talent Index computes from real performances", pass: false, detail: String(e) });
  }

  // ---- M-S4: DARK paths fail closed ----
  try {
    const job = await vision.createJob({ video_url: "https://r2.example/fixture.mp4", version: "V3" });
    checks.push({
      gate: "M-S4",
      name: "Vision V3 fails closed when CV model is DARK",
      pass: job.status === EXPECTED_DARK.vision_v3_status,
      detail: `status=${job.status}`,
    });
  } catch (e) {
    checks.push({ gate: "M-S4", name: "Vision V3 fails closed when CV model is DARK", pass: false, detail: String(e) });
  }

  try {
    await new CoachAIService().analyze({ athlete_id: FIXTURE_ATHLETE });
    checks.push({ gate: "M-S4", name: "Coach AI fails closed when LLM is DARK", pass: false, detail: "did not throw" });
  } catch (e) {
    checks.push({
      gate: "M-S4",
      name: "Coach AI fails closed when LLM is DARK",
      pass: e instanceof ModelUnavailableError,
      detail: e instanceof ModelUnavailableError ? `${e.code} (no fabrication)` : String(e),
    });
  }

  return { lane: "CW15", green: checks.every((c) => c.pass), checks };
}
