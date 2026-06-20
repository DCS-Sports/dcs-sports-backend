/**
 * SELECTION PROBABILITY ENGINE (v3.0).
 *
 * Estimates an athlete's probability of selection (e.g. to the next level) from
 * their performance trajectory. Honest-scope:
 *  - The number is an ESTIMATE and wears the label the validation gate assigns
 *    (estimate until a published backtest bar is met; only then "validated").
 *  - `backtest()` measures the engine against real known outcomes and reports
 *    AUC + sample size + a confidence proxy — the evidence the gate evaluates.
 *
 * The estimate itself is a transparent logistic-style score over normalized
 * features (recent average, strike rate, consistency, trend). It does NOT
 * require a trained model, so it ships now — but it cannot call itself
 * "validated" until a real backtest over real pathways clears the bar.
 */
import type { DBPort, MatchPerformance } from "../db/port";
import { makeEstimate, type Estimate } from "../lib/estimate";
import { gateRegistry, type BacktestEvidence } from "./validation-gate";

const CAPABILITY = "selection_probability";

export interface SelectionProbabilityResult {
  athlete_id: string;
  probability: Estimate; // 0..1 in value; label governed by the gate
  label: "estimate" | "validated";
  sample_size: number;
  features: Record<string, number>;
}

export interface BacktestSample {
  athlete_id: string;
  selected: boolean; // ground-truth outcome
}

export interface BacktestReport {
  capability: string;
  auc: number;
  samples: number;
  confidence: number;
  positive_rate: number;
  evaluated_at: string;
  /** The gate verdict produced by recording this backtest as evidence. */
  gate: ReturnType<typeof gateRegistry.record>;
}

export class SelectionProbabilityService {
  constructor(private db: DBPort) {}

  /** Compute the selection-probability estimate for one athlete. */
  async compute(athleteId: string): Promise<SelectionProbabilityResult> {
    const perfs = await this.db.getMatchPerformances(athleteId);
    const features = this.features(perfs);
    const p = logistic(score(features));
    const confidence = clamp01(0.15 + Math.min(perfs.length, 20) / 20 * 0.6);
    return {
      athlete_id: athleteId,
      probability: makeEstimate({ value: round3(p), confidence, source: "talent", model_version: null }),
      label: gateRegistry.labelFor(CAPABILITY),
      sample_size: perfs.length,
      features,
    };
  }

  /**
   * Backtest against known outcomes. Computes AUC (rank-based), records the
   * evidence in the gate, and returns the report + the gate verdict. This is how
   * the capability earns (or fails to earn) the "validated" label.
   */
  async backtest(samples: BacktestSample[]): Promise<BacktestReport> {
    const scored: Array<{ p: number; y: boolean }> = [];
    for (const s of samples) {
      const r = await this.compute(s.athlete_id);
      scored.push({ p: r.probability.value, y: s.selected });
    }
    const auc = rocAuc(scored);
    const positives = scored.filter((s) => s.y).length;
    const positive_rate = scored.length ? positives / scored.length : 0;
    // Confidence proxy: scales with sample size + class balance (penalize degenerate sets).
    const balance = 1 - Math.abs(0.5 - positive_rate) * 2; // 1 at 50/50, 0 at all-one-class
    const confidence = clamp01(Math.min(scored.length, 1000) / 1000 * 0.6 + balance * 0.4);

    const evidence: BacktestEvidence = {
      capability: CAPABILITY,
      accuracy: round3(auc),
      samples: scored.length,
      confidence: round3(confidence),
      evaluated_at: new Date().toISOString(),
      notes: `positive_rate=${round3(positive_rate)}`,
    };
    const gate = gateRegistry.record(evidence);
    return {
      capability: CAPABILITY,
      auc: round3(auc),
      samples: scored.length,
      confidence: round3(confidence),
      positive_rate: round3(positive_rate),
      evaluated_at: evidence.evaluated_at,
      gate,
    };
  }

  private features(perfs: MatchPerformance[]): Record<string, number> {
    if (perfs.length === 0) {
      return { avg_runs: 0, strike_rate: 0, consistency: 0, trend: 0, wickets_rate: 0 };
    }
    const runs = perfs.map((p) => p.runs);
    const totalRuns = sum(runs);
    const totalBalls = sum(perfs.map((p) => p.balls)) || 1;
    const totalWkts = sum(perfs.map((p) => p.wickets));
    const avg = totalRuns / perfs.length;
    const sr = (totalRuns / totalBalls) * 100;
    const consistency = 1 - normCv(runs);
    const trend = trajectory(runs);
    return {
      avg_runs: round3(avg),
      strike_rate: round3(sr),
      consistency: round3(consistency),
      trend: round3(trend),
      wickets_rate: round3(totalWkts / perfs.length),
    };
  }
}

// ---- transparent scoring (logistic over normalized features) ----
function score(f: Record<string, number>): number {
  // weights are documented + auditable; not a trained model.
  return (
    -3 +
    0.05 * f.avg_runs +
    0.01 * f.strike_rate +
    1.2 * f.consistency +
    0.8 * f.trend +
    0.6 * f.wickets_rate
  );
}
function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ---- ROC AUC via the rank-sum (Mann–Whitney) identity ----
function rocAuc(rows: Array<{ p: number; y: boolean }>): number {
  const pos = rows.filter((r) => r.y).map((r) => r.p);
  const neg = rows.filter((r) => !r.y).map((r) => r.p);
  if (pos.length === 0 || neg.length === 0) return 0.5; // undefined → no signal
  let wins = 0;
  for (const a of pos) for (const b of neg) {
    if (a > b) wins += 1;
    else if (a === b) wins += 0.5;
  }
  return wins / (pos.length * neg.length);
}

function sum(a: number[]) { return a.reduce((x, y) => x + y, 0); }
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round3(n: number) { return Math.round(n * 1000) / 1000; }
function normCv(vals: number[]) {
  if (vals.length < 2) return 0;
  const m = sum(vals) / vals.length;
  const sd = Math.sqrt(sum(vals.map((v) => (v - m) ** 2)) / vals.length);
  return clamp01(sd / (m + 1));
}
function trajectory(vals: number[]) {
  if (vals.length < 2) return 0.5;
  const mid = Math.floor(vals.length / 2);
  const first = sum(vals.slice(0, mid)) / Math.max(mid, 1);
  const last = sum(vals.slice(mid)) / Math.max(vals.length - mid, 1);
  return clamp01(0.5 + (last - first) / (first + last + 1));
}

export { CAPABILITY as SELECTION_CAPABILITY };
