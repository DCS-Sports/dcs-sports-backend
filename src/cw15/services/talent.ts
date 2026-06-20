/**
 * 4.16 TALENT INDEX — heuristic composite (NO AI gate — buildable now).
 *
 * Honest: this is a TRANSPARENT weighted formula over real match_performances +
 * fitness + coach inputs. model_version=null (no trained model). It ships in the
 * S4 estimate envelope and renders "estimate" in UI. When DK provisions a real
 * model, the same surface flips model_version and confidence rises.
 *
 * Sub-scores (0..100): skill, potential, consistency, pressure, fitness, coach.
 * Composite = weighted mean. Weights documented inline so the number is auditable.
 */
import type { DBPort, MatchPerformance, TalentIndexRow } from "../db/port";
import { makeEstimate, type Estimate } from "../lib/estimate";

const WEIGHTS = {
  skill: 0.3,
  potential: 0.15,
  consistency: 0.2,
  pressure: 0.15,
  fitness: 0.1,
  coach: 0.1,
} as const;

export interface TalentInputs {
  fitnessScore?: number; // 0..100 from Performance Lab; default neutral 50
  coachScore?: number; // 0..100 from coach assessments; default neutral 50
}

export interface TalentResult {
  athlete_id: string;
  sub_scores: {
    skill: number;
    potential: number;
    consistency: number;
    pressure: number;
    fitness: number;
    coach: number;
  };
  composite: Estimate; // the headline number, enveloped
  sample_size: number; // matches considered — drives confidence
  computed_at: string;
}

export type TalentWeights = { skill: number; potential: number; consistency: number; pressure: number; fitness: number; coach: number };

export class TalentService {
  private weights: TalentWeights;
  constructor(private db: DBPort, weights?: Partial<TalentWeights>) {
    this.weights = { ...WEIGHTS, ...(weights ?? {}) };
  }

  async compute(athleteId: string, inputs: TalentInputs = {}): Promise<TalentResult> {
    const perfs = await this.db.getMatchPerformances(athleteId);
    const sub = this.subScores(perfs, inputs);
    const W = this.weights;

    const composite =
      sub.skill * W.skill +
      sub.potential * W.potential +
      sub.consistency * W.consistency +
      sub.pressure * W.pressure +
      sub.fitness * W.fitness +
      sub.coach * W.coach;

    // Confidence scales with sample size: 0 matches => 0.1 floor, ~20+ => ~0.8 cap.
    const confidence = clamp01(0.1 + Math.min(perfs.length, 20) / 20 * 0.7);

    const row: TalentIndexRow = {
      athlete_id: athleteId,
      skill: sub.skill,
      potential: sub.potential,
      consistency: sub.consistency,
      pressure: sub.pressure,
      fitness: sub.fitness,
      coach: sub.coach,
      composite: round(composite),
      computed_at: new Date().toISOString(),
    };
    await this.db.upsertTalentIndex(row);

    return {
      athlete_id: athleteId,
      sub_scores: sub,
      composite: makeEstimate({
        value: composite,
        confidence,
        source: "talent",
        model_version: null, // heuristic — honest signal
      }),
      sample_size: perfs.length,
      computed_at: row.computed_at,
    };
  }

  private subScores(perfs: MatchPerformance[], inputs: TalentInputs) {
    if (perfs.length === 0) {
      return {
        skill: 0,
        potential: 0,
        consistency: 0,
        pressure: 0,
        fitness: inputs.fitnessScore ?? 50,
        coach: inputs.coachScore ?? 50,
      };
    }

    const totalRuns = sum(perfs.map((p) => p.runs));
    const totalBalls = sum(perfs.map((p) => p.balls)) || 1;
    const totalWkts = sum(perfs.map((p) => p.wickets));
    const totalCatches = sum(perfs.map((p) => p.catches));
    const innings = perfs.length;

    const sr = (totalRuns / totalBalls) * 100; // strike rate
    const avg = totalRuns / innings; // runs per innings
    const wktRate = totalWkts / innings;

    // skill: batting (SR + avg) + bowling (wkt rate), bounded 0..100
    const skill = clamp(0, 100, avg * 1.2 + sr * 0.15 + wktRate * 18);

    // consistency: inverse of normalized run-score variance (low variance => high)
    const runVals = perfs.map((p) => p.runs);
    const consistency = clamp(0, 100, 100 - normVariance(runVals) * 100);

    // pressure: proxy = boundary share (fours+sixes contribution under tempo)
    const boundaryRuns = sum(perfs.map((p) => p.fours * 4 + p.sixes * 6));
    const pressure = clamp(0, 100, (boundaryRuns / Math.max(totalRuns, 1)) * 120);

    // potential: age-agnostic upside proxy from skill trajectory (last vs first half)
    const potential = clamp(0, 100, trajectory(runVals) * 50 + skill * 0.5);

    return {
      skill: round(skill),
      potential: round(potential),
      consistency: round(consistency),
      pressure: round(pressure),
      fitness: round(inputs.fitnessScore ?? 50),
      coach: round(inputs.coachScore ?? 50),
    };
  }
}

function sum(a: number[]) {
  return a.reduce((x, y) => x + y, 0);
}
function clamp(lo: number, hi: number, n: number) {
  return Math.max(lo, Math.min(hi, n));
}
function clamp01(n: number) {
  return clamp(0, 1, n);
}
function round(n: number) {
  return Math.round(n * 10) / 10;
}
function normVariance(vals: number[]) {
  if (vals.length < 2) return 0;
  const mean = sum(vals) / vals.length;
  const variance = sum(vals.map((v) => (v - mean) ** 2)) / vals.length;
  const sd = Math.sqrt(variance);
  return clamp(0, 1, sd / (mean + 1)); // coefficient-of-variation-ish, bounded
}
function trajectory(vals: number[]) {
  if (vals.length < 2) return 0.5;
  const mid = Math.floor(vals.length / 2);
  const first = sum(vals.slice(0, mid)) / Math.max(mid, 1);
  const last = sum(vals.slice(mid)) / Math.max(vals.length - mid, 1);
  return clamp(0, 1, 0.5 + (last - first) / (first + last + 1));
}

export { WEIGHTS };
