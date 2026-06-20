// CW12 — form + consistency analytics (R4 feed for CW13 Selection Intelligence).
// These are COUNTED facts derived from sports_match_performances — not predictions.
// CW13's Selection Intelligence consumes these as inputs and adds its own model
// (form/consistency/pressure/age/venue), which it must ship estimate-labeled.
// CW12's outputs here are exact (no estimate flag) because they are arithmetic over real data.
//
// Honest-scope: CW12 does not score "potential" or "selectability" — that's CW13's model.
// We only report what happened: recent runs, strike rate, wickets, and the statistical
// consistency (coefficient of variation) of an athlete's match-by-match output.

import type { MatchPerformance } from '../types/index';

export interface PerMatchLine {
  match_id: string;
  runs: number;
  balls: number;
  wickets: number;
  strike_rate: number;
}

export interface AthleteForm {
  athlete_id: string;
  matches_considered: number;       // size of the rolling window actually used
  recent_runs: number[];            // most-recent-first
  total_runs: number;
  total_wickets: number;
  batting_average: number | null;   // runs / dismissals-as-proxy (innings here); null if no innings
  strike_rate: number;              // aggregate over the window
  // consistency: lower CV = steadier. null when < 2 innings (undefined variance).
  consistency_cv: number | null;
  trend: 'rising' | 'falling' | 'flat' | 'insufficient'; // last-3 vs prior-3 runs
  source: 'league_os';
  computed_at: string;
}

/**
 * Build a chronological per-match line list for one athlete.
 * Order is determined by the caller's match ordering (pass perfs already ordered
 * oldest->newest, or supply matchOrder). We keep it simple: callers pass perfs in
 * the order matches were played.
 */
export function perMatchLines(perfs: MatchPerformance[]): PerMatchLine[] {
  return perfs.map((p) => ({
    match_id: p.match_id,
    runs: p.runs,
    balls: p.balls,
    wickets: p.wickets,
    strike_rate: p.balls > 0 ? +((p.runs / p.balls) * 100).toFixed(2) : 0,
  }));
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Compute an athlete's form over the most recent `windowSize` matches.
 * `perfs` MUST be ordered oldest -> newest (the order matches were played).
 * Returns counted facts only.
 */
export function computeForm(
  athlete_id: string,
  perfs: MatchPerformance[],
  windowSize = 5,
): AthleteForm {
  const lines = perMatchLines(perfs);
  const window = lines.slice(-windowSize);             // most recent N (chronological)
  const recentFirst = [...window].reverse();           // most-recent-first for display
  const runs = window.map((l) => l.runs);
  const balls = window.reduce((a, l) => a + l.balls, 0);
  const totalRuns = runs.reduce((a, b) => a + b, 0);
  const totalWkts = window.reduce((a, l) => a + l.wickets, 0);
  const innings = window.length;

  const sd = stddev(runs);
  const avg = mean(runs);
  const cv = innings >= 2 && avg > 0 ? +(sd / avg).toFixed(3) : null;

  return {
    athlete_id,
    matches_considered: innings,
    recent_runs: recentFirst.map((l) => l.runs),
    total_runs: totalRuns,
    total_wickets: totalWkts,
    batting_average: innings > 0 ? +(totalRuns / innings).toFixed(2) : null,
    strike_rate: balls > 0 ? +((totalRuns / balls) * 100).toFixed(2) : 0,
    consistency_cv: cv,
    trend: computeTrend(runs),
    source: 'league_os',
    computed_at: new Date().toISOString(),
  };
}

/** last-3 mean vs prior-3 mean. Needs >= 4 innings to say anything; else 'insufficient'. */
function computeTrend(runsChrono: number[]): AthleteForm['trend'] {
  if (runsChrono.length < 4) return 'insufficient';
  const last3 = runsChrono.slice(-3);
  const prior = runsChrono.slice(0, -3);
  const priorTail = prior.slice(-3);
  const a = mean(last3);
  const b = mean(priorTail);
  const delta = a - b;
  const threshold = Math.max(5, b * 0.15); // 5 runs or 15% of prior baseline
  if (delta > threshold) return 'rising';
  if (delta < -threshold) return 'falling';
  return 'flat';
}

/**
 * Group league performances by athlete and compute form for each.
 * `matchOrder` maps match_id -> sequence index so we can order chronologically
 * (League OS knows fixture/match order; pass it in). Without it we use insertion order.
 */
export function leagueForm(
  perfs: MatchPerformance[],
  windowSize = 5,
  matchOrder?: Record<string, number>,
): AthleteForm[] {
  const byAthlete: Record<string, MatchPerformance[]> = {};
  for (const p of perfs) (byAthlete[p.athlete_id] ??= []).push(p);

  const out: AthleteForm[] = [];
  for (const [athlete_id, list] of Object.entries(byAthlete)) {
    const ordered = matchOrder
      ? [...list].sort((x, y) => (matchOrder[x.match_id] ?? 0) - (matchOrder[y.match_id] ?? 0))
      : list;
    out.push(computeForm(athlete_id, ordered, windowSize));
  }
  return out;
}
