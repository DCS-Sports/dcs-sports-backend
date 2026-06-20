/**
 * 4.16 TALENT INDEX v2 — batch recompute + calibration harness.
 *
 * Build-now half of the adoption-gated moat (R6): the recompute reprocesses
 * every athlete's talent score as League OS produces real match data at volume;
 * the calibration harness measures how well the heuristic ranks athletes against
 * a real outcome signal (e.g. selections), so the weights can be VALIDATED and
 * tuned once data exists — without changing the formula's honesty.
 *
 * Honest-scope: still a transparent heuristic (model_version:null, estimate).
 * Calibration does NOT auto-ship new weights; it reports a score + a suggested
 * weight set for human review. Nothing about money or fail-closed AI changes.
 */
import type { DBPort } from "../db/port";
import { TalentService, type TalentWeights } from "./talent";

/** Thrown when a recompute is requested while one is already running. */
export class RecomputeBusyError extends Error {
  readonly code = "RECOMPUTE_BUSY";
  constructor() {
    super("A talent recompute is already running. Try again once it completes.");
    this.name = "RecomputeBusyError";
  }
}

export interface RecomputeResult {
  total: number;
  recomputed: number;
  errors: Array<{ athlete_id: string; error: string }>;
  duration_ms: number;
}

export interface CalibrationSample {
  athlete_id: string;
  /** A real outcome signal to calibrate against, higher = better (e.g. selection tier, runs next season). */
  outcome: number;
}

export interface CalibrationReport {
  n: number;
  /** Spearman rank correlation between composite and outcome (-1..1). Higher = the index ranks athletes the way reality did. */
  spearman: number;
  /** The weights used for this evaluation. */
  weights: TalentWeights;
  /** A candidate weight set from a small grid search, for HUMAN review (not auto-applied). */
  suggested_weights?: TalentWeights;
  suggested_spearman?: number;
  note: string;
}

export class TalentRecomputeService {
  // In-process guard: a recompute is heavy (iterates all athletes). Prevent
  // overlapping runs from piling up (e.g. a cron + a manual trigger colliding).
  private static running = false;

  constructor(private db: DBPort) {}

  /**
   * Recompute talent for every athlete that has match performances.
   * Runs server-side (service role). Safe to schedule (e.g. nightly BullMQ job).
   * Guarded against concurrent runs; honors a hard safety cap.
   */
  async recomputeAll(opts?: { weights?: Partial<TalentWeights>; limit?: number }): Promise<RecomputeResult> {
    if (TalentRecomputeService.running) {
      throw new RecomputeBusyError();
    }
    TalentRecomputeService.running = true;
    try {
      const started = Date.now();
      const ids = await this.db.listAthleteIdsWithPerformances();
      // Hard safety cap so one call can't run unbounded; callers paginate via limit.
      const HARD_CAP = 5000;
      const effectiveLimit = Math.min(opts?.limit ?? HARD_CAP, HARD_CAP);
      const batch = ids.slice(0, effectiveLimit);
      const talent = new TalentService(this.db, opts?.weights);
      const errors: Array<{ athlete_id: string; error: string }> = [];
      let recomputed = 0;
      for (const id of batch) {
        try {
          await talent.compute(id);
          recomputed++;
        } catch (e) {
          errors.push({ athlete_id: id, error: (e as Error).message });
        }
      }
      return { total: ids.length, recomputed, errors, duration_ms: Date.now() - started };
    } finally {
      TalentRecomputeService.running = false;
    }
  }

  /**
   * Calibration: how well does the current heuristic rank athletes vs a real
   * outcome signal? Returns a Spearman correlation + a human-review weight
   * suggestion from a coarse grid search. Never auto-applies weights.
   */
  async calibrate(samples: CalibrationSample[], baseWeights?: Partial<TalentWeights>): Promise<CalibrationReport> {
    if (samples.length < 3) {
      return {
        n: samples.length,
        spearman: 0,
        weights: new TalentService(this.db, baseWeights)["weights"] as TalentWeights,
        note: "Need >=3 samples with real outcomes to calibrate. Adoption-gated: this becomes meaningful once League OS produces real selections/results.",
      };
    }

    const evalWeights = async (w?: Partial<TalentWeights>): Promise<{ rho: number; weights: TalentWeights }> => {
      const svc = new TalentService(this.db, w);
      const composites: number[] = [];
      const outcomes: number[] = [];
      for (const s of samples) {
        const r = await svc.compute(s.athlete_id);
        composites.push(r.composite.value);
        outcomes.push(s.outcome);
      }
      return { rho: spearman(composites, outcomes), weights: (svc as any)["weights"] as TalentWeights };
    };

    const base = await evalWeights(baseWeights);

    // Coarse grid search: nudge skill/consistency weight up/down, renormalize.
    let best = base;
    for (const dSkill of [-0.1, 0, 0.1]) {
      for (const dConsistency of [-0.1, 0, 0.1]) {
        if (dSkill === 0 && dConsistency === 0) continue;
        const candidate = normalizeWeights({
          ...base.weights,
          skill: base.weights.skill + dSkill,
          consistency: base.weights.consistency + dConsistency,
        });
        const r = await evalWeights(candidate);
        if (r.rho > best.rho) best = r;
      }
    }

    const improved = best.rho > base.rho + 1e-9;
    return {
      n: samples.length,
      spearman: round3(base.rho),
      weights: base.weights,
      suggested_weights: improved ? best.weights : undefined,
      suggested_spearman: improved ? round3(best.rho) : undefined,
      note: improved
        ? "A better-ranking weight set exists for this data. Review before applying — calibration never auto-ships weights."
        : "Current weights rank this sample as well as the grid neighbors. No change suggested.",
    };
  }
}

// ---- stats helpers ----
function spearman(a: number[], b: number[]): number {
  const ra = ranks(a);
  const rb = ranks(b);
  return pearson(ra, rb);
}
function ranks(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array(xs.length).fill(0);
  // average ranks for ties
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avgRank;
    i = j + 1;
  }
  return r;
}
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0) return 0;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}
function mean(xs: number[]) { return xs.reduce((s, x) => s + x, 0) / xs.length; }
function normalizeWeights(w: TalentWeights): TalentWeights {
  const clamped = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.max(0, v)])) as TalentWeights;
  const sum = Object.values(clamped).reduce((s, v) => s + v, 0) || 1;
  return Object.fromEntries(Object.entries(clamped).map(([k, v]) => [k, v / sum])) as TalentWeights;
}
function round3(n: number) { return Math.round(n * 1000) / 1000; }
