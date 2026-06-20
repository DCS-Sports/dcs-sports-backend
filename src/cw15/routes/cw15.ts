/**
 * CW15 routes — frozen S2 surface:
 *   POST /vision/jobs · GET /vision/jobs/:id
 *   POST /coach-ai/analyze · POST /coach-ai/plan
 *   GET  /athletes/:id/talent · GET /athletes/:id/fitness
 *   POST /athletes/:id/fitness   (Performance Lab ingest — CW15-owned)
 *
 * ModelUnavailableError -> HTTP 503 with a structured body the UI renders as
 * "AI unavailable (not provisioned)" — honest, never fabricated.
 */
import { Router } from "express";
import { z } from "zod";
import type { DBPort } from "../db/port";
import type { Queue } from "../lib/queue";
import { VisionService, type VisionVersion, type VisionModelRunner } from "../services/vision";
import { DrillService, type DrillModelRunner } from "../services/drill";
import { DRILL_TYPES, type DrillType } from "../services/drill-contracts";
import { CoachAIService, type LLMRunner } from "../services/coach-ai";
import { TalentService } from "../services/talent";
import { TalentRecomputeService, RecomputeBusyError } from "../services/talent-recompute";
import { SelectionProbabilityService } from "../services/selection-probability";
import { SelectionIntelligenceService, type RankingMetric } from "../services/selection-intelligence";
import { gateRegistry, VALIDATION_BARS } from "../services/validation-gate";
import { PerformanceLabService } from "../services/performance-lab";
import { ModelUnavailableError, AdminRequiredError } from "../lib/estimate";
import { buildUploadTarget } from "../lib/r2";
import { metrics, logRequest } from "../lib/metrics";

export type DBFactory = (callerToken?: string | null) => DBPort;

export interface RouterRunners {
  visionModelRunner?: VisionModelRunner;
  llmRunner?: LLMRunner;
  drillModelRunner?: DrillModelRunner;
}

function bearer(req: any): string | null {
  const h = req.headers?.authorization as string | undefined;
  if (h && h.startsWith("Bearer ")) return h.slice(7);
  return null;
}

/** Normalize a request path to a low-cardinality route label for metrics. */
function routeLabel(req: any): string {
  // express sets req.route on matched routes; fall back to a normalized path.
  const base = (req.baseUrl || "") + (req.route?.path || req.path || "");
  return base
    .replace(/\/athletes\/[^/]+/g, "/athletes/:id")
    .replace(/\/vision\/jobs\/[^/]+/g, "/vision/jobs/:id");
}

export function buildRouter(dbFactory: DBFactory, queue: Queue, runners: RouterRunners = {}): Router {
  const r = Router();

  // ---- observability: time every request, label by route (not raw path) ----
  r.use((req: any, res: any, next: any) => {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      const label = routeLabel(req);
      metrics.recordRequest(req.method, label, res.statusCode, ms);
      logRequest({ method: req.method, path: label, status: res.statusCode, ms });
    });
    next();
  });

  // Metrics feed for CW16's monitoring/status page.
  r.get("/cw15/metrics", (_req, res) => res.json(metrics.snapshot()));

  // Vision worker uses a service-role (tokenless) DB for writes.
  const serviceDb = dbFactory(null);
  const visionWorker = new VisionService(serviceDb, queue, runners.visionModelRunner);
  queue.process<{ jobId: string }>("vision", async (job) => {
    await visionWorker.process(job.data.jobId);
  });

  // aiScout drill worker (separate queue, same service-role DB).
  const drillWorker = new DrillService(serviceDb, queue, runners.drillModelRunner);
  queue.process<{ jobId: string }>("drill", async (job) => {
    await drillWorker.process(job.data.jobId);
  });

  const wrap =
    (fn: (req: any, res: any) => Promise<void>) =>
    async (req: any, res: any) => {
      try {
        await fn(req, res);
      } catch (e) {
        if (e instanceof ModelUnavailableError) {
          metrics.inc("model_unavailable");
          metrics.inc(`model_unavailable_${e.requires}`);
          res.status(503).json({
            error: e.code,
            capability: e.capability,
            requires: e.requires,
            message: e.message,
          });
          return;
        }
        if (e instanceof RecomputeBusyError) {
          metrics.inc("recompute_busy_rejected");
          res.status(409).json({ error: e.code, message: e.message });
          return;
        }
        if (e instanceof AdminRequiredError) {
          metrics.inc("admin_required_rejected");
          res.status(403).json({ error: e.code, message: e.message });
          return;
        }
        res.status(400).json({ error: "BAD_REQUEST", message: (e as Error).message });
      }
    };

  // ---- VISION ----
  const visionBody = z.object({
    video_url: z.string().url(),
    match_id: z.string().nullable().optional(),
    version: z.enum(["V1", "V2", "V3", "V4"]).default("V1"),
  });

  // Where the client uploads a video before submitting a job (R2).
  r.post(
    "/vision/upload-target",
    wrap(async (req, res) => {
      const b = z.object({ match_id: z.string().nullable().optional(), filename: z.string().min(1) }).parse(req.body);
      res.json(buildUploadTarget(b.match_id ?? null, b.filename));
    }),
  );
  r.post(
    "/vision/jobs",
    wrap(async (req, res) => {
      const b = visionBody.parse(req.body);
      const vision = new VisionService(dbFactory(null), queue, runners.visionModelRunner);
      const job = await vision.createJob({
        video_url: b.video_url,
        match_id: b.match_id ?? null,
        version: b.version as VisionVersion,
      });
      metrics.inc("vision_job_created");
      metrics.inc(`vision_job_${job.status}`);
      res.status(201).json(job);
    }),
  );
  r.get(
    "/vision/jobs/:id",
    wrap(async (req, res) => {
      const vision = new VisionService(dbFactory(null), queue, runners.visionModelRunner);
      const result = await vision.getJob(req.params.id);
      if (!result) {
        res.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      res.json(result);
    }),
  );

  // ---- aiScout DRILL ASSESSMENT (v2.0 headline) ----
  r.get("/drills/types", (_req, res) => res.json({ drills: DRILL_TYPES }));
  r.post(
    "/drills",
    wrap(async (req, res) => {
      const b = z
        .object({
          athlete_id: z.string().min(1).max(128),
          drill: z.enum(DRILL_TYPES as [DrillType, ...DrillType[]]),
          video_url: z.string().url(),
        })
        .parse(req.body);
      const drill = new DrillService(dbFactory(null), queue, runners.drillModelRunner);
      const job = await drill.createJob(b);
      metrics.inc("drill_job_created");
      metrics.inc(`drill_job_${job.status}`);
      res.status(201).json(job);
    }),
  );
  r.get(
    "/drills/:id",
    wrap(async (req, res) => {
      const drill = new DrillService(dbFactory(null), queue, runners.drillModelRunner);
      const result = await drill.getJob(req.params.id);
      if (!result) {
        res.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      res.json(result);
    }),
  );
  r.post(
    "/coach-ai/analyze",
    wrap(async (req, res) => {
      const b = z.object({ athlete_id: z.string(), vision_job_id: z.string().optional() }).parse(req.body);
      // grounded context reads athlete data -> thread caller token for RLS
      const coach = new CoachAIService(dbFactory(bearer(req)), runners.llmRunner);
      res.json(await coach.analyze(b));
    }),
  );
  r.post(
    "/coach-ai/plan",
    wrap(async (req, res) => {
      const b = z.object({ athlete_id: z.string(), focus_areas: z.array(z.string()).optional() }).parse(req.body);
      const coach = new CoachAIService(dbFactory(bearer(req)), runners.llmRunner);
      res.json(await coach.plan(b));
    }),
  );

  // ---- TALENT ----
  r.get(
    "/athletes/:id/talent",
    wrap(async (req, res) => {
      // athlete-owned read -> thread caller token so match_performances goes through RLS
      const db = dbFactory(bearer(req));
      const lab = new PerformanceLabService(db);
      const talent = new TalentService(db);
      const fitness = await lab.summary(req.params.id);
      const result = await talent.compute(req.params.id, {
        fitnessScore: fitness.fitnessScore ?? undefined,
      });
      res.json(result);
    }),
  );

  // ---- PERFORMANCE LAB ----
  r.get(
    "/athletes/:id/fitness",
    wrap(async (req, res) => {
      const lab = new PerformanceLabService(dbFactory(bearer(req)));
      res.json(await lab.summary(req.params.id));
    }),
  );
  r.post(
    "/athletes/:id/fitness",
    wrap(async (req, res) => {
      const b = z.object({ type: z.string(), value: z.number(), date: z.string().optional() }).parse(req.body);
      // write -> service role
      const lab = new PerformanceLabService(dbFactory(null));
      const row = await lab.record({ athlete_id: req.params.id, ...b });
      res.status(201).json(row);
    }),
  );

  // ---- SELECTION PROBABILITY ENGINE (v3.0) + MODEL-LIVE VALIDATION GATE ----
  r.get(
    "/athletes/:id/selection-probability",
    wrap(async (req, res) => {
      // athlete-owned read -> thread caller token for RLS on match_performances
      const svc = new SelectionProbabilityService(dbFactory(bearer(req)));
      res.json(await svc.compute(req.params.id));
    }),
  );
  // Published bars + current verdicts — public, auditable, no PII.
  r.get("/cw15/validation-gate", (_req, res) => {
    res.json({ bars: VALIDATION_BARS, verdicts: gateRegistry.all() });
  });
  // Run a backtest to (try to) validate the engine. Admin-only; records evidence.
  r.post(
    "/selection/backtest",
    wrap(async (req, res) => {
      const callerDb = dbFactory(bearer(req));
      if (!(await callerDb.callerIsAdmin())) throw new AdminRequiredError();
      const b = z
        .object({
          samples: z.array(z.object({ athlete_id: z.string().min(1).max(128), selected: z.boolean() })).max(20000),
        })
        .parse(req.body);
      const svc = new SelectionProbabilityService(dbFactory(null));
      const report = await svc.backtest(b.samples);
      metrics.inc("selection_backtest_runs");
      if (report.gate.validated) metrics.inc("selection_validated");
      res.json(report);
    }),
  );

  // ---- SELECTION INTELLIGENCE selector (v4.0): "best U19 spinner" etc. ----
  // Association-facing. Reads candidates THROUGH RLS (caller token) so minors /
  // private athletes never surface. Scores are gate-governed + carry confidence
  // + sample size. Requires a bound token (entitled action).
  r.post(
    "/selection/selector",
    wrap(async (req, res) => {
      const token = bearer(req);
      if (!token) {
        res.status(401).json({ error: "AUTH_REQUIRED", message: "Selection Intelligence requires a signed-in association/scout token." });
        return;
      }
      const b = z
        .object({
          sport: z.string().max(64).optional(),
          role: z.string().max(64).optional(),
          bowling_style: z.string().max(64).optional(),
          state: z.string().max(64).optional(),
          min_age: z.number().int().min(0).max(120).optional(),
          max_age: z.number().int().min(0).max(120).optional(),
          metric: z.enum(["best", "fastest_improving", "selection_probability"]).default("best"),
          limit: z.number().int().positive().max(200).optional(),
        })
        .parse(req.body ?? {});
      const svc = new SelectionIntelligenceService(dbFactory(token));
      const result = await svc.select({ ...b, metric: b.metric as RankingMetric });
      metrics.inc("selector_queries");
      metrics.inc(`selector_metric_${b.metric}`);
      res.json(result);
    }),
  );

  // ---- TALENT v2: batch recompute + calibration (ADMIN-ONLY, service role) ----
  // Defense-in-depth: even though CW9's gateway gate sits in front, this lane
  // independently verifies the caller has the `admin` role flag before running a
  // platform-wide recompute. No admin -> 403, never runs.
  r.post(
    "/talent/recompute",
    wrap(async (req, res) => {
      const callerDb = dbFactory(bearer(req));
      if (!(await callerDb.callerIsAdmin())) throw new AdminRequiredError();
      const b = z
        .object({
          limit: z.number().int().positive().max(5000).optional(),
          weights: z
            .object({
              skill: z.number().min(0).max(1), potential: z.number().min(0).max(1),
              consistency: z.number().min(0).max(1), pressure: z.number().min(0).max(1),
              fitness: z.number().min(0).max(1), coach: z.number().min(0).max(1),
            })
            .partial()
            .optional(),
        })
        .parse(req.body ?? {});
      const recompute = new TalentRecomputeService(dbFactory(null));
      const result = await recompute.recomputeAll({ limit: b.limit, weights: b.weights });
      metrics.inc("talent_recompute_runs");
      metrics.inc("talent_recompute_athletes", result.recomputed);
      res.json(result);
    }),
  );
  r.post(
    "/talent/calibrate",
    wrap(async (req, res) => {
      const callerDb = dbFactory(bearer(req));
      if (!(await callerDb.callerIsAdmin())) throw new AdminRequiredError();
      const b = z
        .object({
          samples: z.array(z.object({ athlete_id: z.string().min(1).max(128), outcome: z.number() })).max(5000),
          base_weights: z
            .object({
              skill: z.number().min(0).max(1), potential: z.number().min(0).max(1),
              consistency: z.number().min(0).max(1), pressure: z.number().min(0).max(1),
              fitness: z.number().min(0).max(1), coach: z.number().min(0).max(1),
            })
            .partial()
            .optional(),
        })
        .parse(req.body);
      const recompute = new TalentRecomputeService(dbFactory(null));
      res.json(await recompute.calibrate(b.samples, b.base_weights));
    }),
  );

  return r;
}
