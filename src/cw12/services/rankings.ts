// CW12 — Rankings + certificates (R2). Pure functions over aggregated performances.
// Rankings are deterministic, derived from real match data only — NO AI, NO estimate
// (this is counted data, not a model output). Certificates are issued from league
// standings/leaderboard facts (e.g. "Top Run Scorer — Hisar T20 2026").

import type { LeaderboardRow, MatchPerformance, StandingRow } from '../types/index';
import { computeLeaderboard } from './standings';

export interface RankingRow {
  rank: number;
  athlete_id: string;
  metric: number;
  matches: number;
}

export type RankingCategory = 'runs' | 'wickets' | 'catches' | 'strike_rate';

/** Rank athletes within a league for a given category. Ties share data order (stable). */
export function rankAthletes(
  sport: string,
  performances: MatchPerformance[],
  category: RankingCategory,
): RankingRow[] {
  const lb: LeaderboardRow[] = computeLeaderboard(sport, performances);
  const metricOf = (r: LeaderboardRow): number => {
    switch (category) {
      case 'runs': return r.runs;
      case 'wickets': return r.wickets;
      case 'catches': return r.catches;
      case 'strike_rate': return r.batting_strike_rate;
    }
  };
  const sorted = [...lb].sort((a, b) => metricOf(b) - metricOf(a));
  return sorted.map((r, i) => ({
    rank: i + 1,
    athlete_id: r.athlete_id,
    metric: metricOf(r),
    matches: r.matches,
  }));
}

export interface Certificate {
  type: 'champion' | 'top_run_scorer' | 'top_wicket_taker' | 'participation';
  title: string;
  subject_id: string; // team_id or athlete_id
  league_id: string;
  league_name: string;
  detail: string;
  issued_at: string;
}

/**
 * Build the set of certificates a completed league earns, from facts only.
 * Champion = standings winner; awards = leaderboard leaders. No fabrication —
 * if there's no data for a category, no certificate is issued.
 */
export function buildCertificates(
  league_id: string,
  league_name: string,
  sport: string,
  standings: StandingRow[],
  performances: MatchPerformance[],
): Certificate[] {
  const now = new Date().toISOString();
  const out: Certificate[] = [];

  if (standings.length > 0 && standings[0].played > 0) {
    out.push({
      type: 'champion', title: 'League Champions',
      subject_id: standings[0].team_id, league_id, league_name,
      detail: `${standings[0].team_name} — ${standings[0].won} wins, ${standings[0].points} pts`,
      issued_at: now,
    });
  }

  const byRuns = rankAthletes(sport, performances, 'runs');
  if (byRuns.length > 0 && byRuns[0].metric > 0) {
    out.push({
      type: 'top_run_scorer', title: 'Top Run Scorer',
      subject_id: byRuns[0].athlete_id, league_id, league_name,
      detail: `${byRuns[0].metric} runs in ${byRuns[0].matches} matches`,
      issued_at: now,
    });
  }

  const byWkts = rankAthletes(sport, performances, 'wickets');
  if (byWkts.length > 0 && byWkts[0].metric > 0) {
    out.push({
      type: 'top_wicket_taker', title: 'Top Wicket Taker',
      subject_id: byWkts[0].athlete_id, league_id, league_name,
      detail: `${byWkts[0].metric} wickets in ${byWkts[0].matches} matches`,
      issued_at: now,
    });
  }

  return out;
}
