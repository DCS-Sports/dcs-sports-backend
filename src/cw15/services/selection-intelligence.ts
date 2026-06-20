/**
 * SELECTION INTELLIGENCE — selector tool (v4.0 headline).
 *
 * Answers association queries like "best U19 off-spinner in Haryana" or
 * "fastest-improving batter" → a RANKED list of athletes, each with a score,
 * CONFIDENCE, and SAMPLE SIZE. Honest-scope, non-negotiable:
 *  - Candidate discovery goes THROUGH RLS (findDiscoverableAthletes) so minors
 *    and private athletes never appear. The selector cannot widen visibility.
 *  - Every ranked score is an ESTIMATE and wears the label the validation gate
 *    assigns to its underlying capability (talent_index / selection_probability).
 *    Nothing is presented as "validated" unless the gate says so.
 *  - Athletes with no performance data get a low-confidence, sample_size:0 entry,
 *    never a fabricated ranking.
 *
 * This is a transparent ranking over existing estimates — NOT a trained model.
 * The "DCS Cricket Model v0" slot is the model seam: when a real model is wired
 * and passes the published bar, its scores replace the heuristic here and the
 * gate flips the label. Until then this ships, clearly labelled estimate.
 */
import type { DBPort, AthleteProfile } from "../db/port";
import { TalentService } from "./talent";
import { SelectionProbabilityService } from "./selection-probability";
import { gateRegistry } from "./validation-gate";

export type RankingMetric = "best" | "fastest_improving" | "selection_probability";

export interface SelectorQuery {
  sport?: string;
  role?: string;
  bowling_style?: string;
  state?: string;
  min_age?: number;
  max_age?: number;
  metric: RankingMetric;
  limit?: number;
}

export interface RankedAthlete {
  athlete_id: string;
  rank: number;
  score: number;          // 0..100 (talent/best) or 0..1 (selection_probability)
  confidence: number;     // 0..1
  sample_size: number;    // # matches backing the score (honesty signal)
  label: "estimate" | "validated";
  why: string;            // short, human-readable rationale
}

export interface SelectorResult {
  query: SelectorQuery;
  metric: RankingMetric;
  /** The gate label governing this metric's outputs right now. */
  label: "estimate" | "validated";
  candidate_count: number;
  results: RankedAthlete[];
  note: string;
}

export class SelectionIntelligenceService {
  constructor(private db: DBPort) {}

  async select(query: SelectorQuery): Promise<SelectorResult> {
    const candidates = await this.db.findDiscoverableAthletes({
      sport: query.sport,
      role: query.role,
      bowling_style: query.bowling_style,
      state: query.state,
      min_age: query.min_age,
      max_age: query.max_age,
      limit: Math.min(query.limit ?? 25, 200),
    });

    const metric = query.metric;
    const capability = metric === "selection_probability" ? "selection_probability" : "talent_index";
    const gateLabel = gateRegistry.labelFor(capability);

    const scored = await Promise.all(candidates.map((a) => this.scoreOne(a, metric, gateLabel)));
    // Rank desc by score, then by confidence (tie-break), then sample_size.
    scored.sort((x, y) => y.score - x.score || y.confidence - x.confidence || y.sample_size - x.sample_size);
    scored.forEach((r, i) => (r.rank = i + 1));

    return {
      query,
      metric,
      label: gateLabel,
      candidate_count: candidates.length,
      results: scored.slice(0, Math.min(query.limit ?? 25, 200)),
      note:
        candidates.length === 0
          ? "No discoverable athletes match this query (minors/private are never surfaced)."
          : `Ranked ${scored.length} discoverable athletes by ${metric}. All scores are ${gateLabel}; confidence + sample size shown per athlete.`,
    };
  }

  private async scoreOne(
    a: AthleteProfile,
    metric: RankingMetric,
    gateLabel: "estimate" | "validated",
  ): Promise<RankedAthlete> {
    if (metric === "selection_probability") {
      const sp = new SelectionProbabilityService(this.db);
      const r = await sp.compute(a.id);
      return {
        athlete_id: a.id,
        rank: 0,
        score: r.probability.value,
        confidence: r.probability.confidence,
        sample_size: r.sample_size,
        label: r.label,
        why: `selection probability ${(r.probability.value * 100).toFixed(0)}% over ${r.sample_size} matches`,
      };
    }

    const talent = new TalentService(this.db);
    const t = await talent.compute(a.id);
    if (metric === "fastest_improving") {
      // Use the talent "potential/trend" lens: reward upward trajectory.
      const perfs = await this.db.getMatchPerformances(a.id);
      const improve = trajectory(perfs.map((p) => p.runs));
      const score = round1(improve * 100);
      return {
        athlete_id: a.id,
        rank: 0,
        score,
        confidence: t.composite.confidence,
        sample_size: perfs.length,
        label: gateLabel,
        why: `improvement trend ${score}/100 over ${perfs.length} matches`,
      };
    }
    // "best" → talent composite
    return {
      athlete_id: a.id,
      rank: 0,
      score: t.composite.value,
      confidence: t.composite.confidence,
      sample_size: t.sample_size,
      label: gateLabel,
      why: `talent index ${t.composite.value}/100 over ${t.sample_size} matches`,
    };
  }
}

function trajectory(vals: number[]): number {
  if (vals.length < 2) return 0.5;
  const mid = Math.floor(vals.length / 2);
  const first = avg(vals.slice(0, mid));
  const last = avg(vals.slice(mid));
  return clamp01(0.5 + (last - first) / (first + last + 1));
}
function avg(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round1(n: number) { return Math.round(n * 10) / 10; }
