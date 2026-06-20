// CW12 League OS — types
// Derived 1:1 from the frozen S1 schema (sports_ tables) and the S2 ball-by-ball
// event contract. Do not widen these without a contract change from the manager.

// ---- S1: sports_leagues ----
export type LeagueFormat = 'round_robin' | 'knockout' | 'hybrid';

export interface League {
  id: string;
  name: string;
  organizer_user_id: string;
  format: LeagueFormat;
  level: string | null;
  season: string | null;
  sport: string; // sport-agnostic: FK to sports_sport_config.sport (cricket = config #1)
  max_overs?: number | null; // overs per innings (T20=20); drives NRR quota when a side is all out
}

// ---- S1: sports_teams / sports_team_players ----
export interface Team {
  id: string;
  league_id: string;
  name: string;
  academy_id: string | null;
}

export interface TeamPlayer {
  team_id: string;
  athlete_id: string;
}

// ---- S1: sports_fixtures ----
export interface Fixture {
  id: string;
  league_id: string;
  round: number;
  home_team_id: string;
  away_team_id: string | null; // null = bye
  venue: string | null;
  scheduled_at: string | null; // iso
}

// ---- S1: sports_matches ----
export type MatchStatus = 'scheduled' | 'live' | 'completed' | 'abandoned';

export interface Match {
  id: string;
  league_id: string;
  type: string;
  home_team_id: string;
  away_team_id: string;
  venue: string | null;
  date: string | null;
  status: MatchStatus;
  result: string | null;
  innings_summary?: MatchInningsSummary[] | null; // persisted at close for NRR
}

// ---- S1: sports_live_scores (one row per ball / event) ----
export interface LiveScoreRow {
  id: string;
  match_id: string;
  innings: number;
  over: number;
  ball: number;
  event_json: ScoreEvent;
  ts: string; // iso
}

// ---- S2 FROZEN ball-by-ball event shape (M-S1 contract CW10 reads) ----
// {match_id, athlete_id, event:'run'|'wicket'|'catch'|..., runs?, ball, over, ts}
export type ScoreEventType =
  | 'run'
  | 'wicket'
  | 'catch'
  | 'wide'
  | 'no_ball'
  | 'bye'
  | 'leg_bye'
  | 'dot';

export interface ScoreEvent {
  match_id: string;
  athlete_id: string; // striker (run/dot) | bowler (wicket) | fielder (catch)
  event: ScoreEventType;
  runs?: number; // present for 'run', extras
  ball: number; // 1..6 within the over (legal ball counter)
  over: number; // 0-indexed completed overs
  ts: string; // iso
  // optional cricket context (sport-agnostic engine ignores unknown fields)
  innings?: number;
  bowler_id?: string; // for wicket attribution to bowler
  dismissed_id?: string; // who got out
  dismissal?: 'bowled' | 'caught' | 'lbw' | 'run_out' | 'stumped' | 'hit_wicket';
  fielder_id?: string; // for catch credit
  boundary?: 4 | 6;
}

// ---- S1: sports_match_performances (the aggregate CW10 / CW14 consume) ----
// One row per (match_id, athlete_id). The scoring engine recomputes this from events.
export interface MatchPerformance {
  id?: string;
  match_id: string;
  athlete_id: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  overs: number; // overs bowled
  wickets: number;
  runs_conceded: number;
  catches: number;
  source: 'match'; // CW12 only ever writes source='match'
}

// ---- Standings / leaderboard (computed, not stored as canonical) ----
export interface StandingRow {
  team_id: string;
  team_name: string;
  played: number;
  won: number;
  lost: number;
  tied: number;
  no_result: number;
  points: number;
  net_run_rate: number; // cricket; generic engines may report 0
}

export interface LeaderboardRow {
  athlete_id: string;
  runs: number;
  wickets: number;
  matches: number;
  catches: number;
  batting_strike_rate: number;
}

// ---- match close / result computation ----
export interface InningsTotals {
  innings: number;
  runs: number;
  wickets: number;
}

// Per-team innings summary persisted at match close, so NRR can be computed
// across a league without replaying every ball event.
export interface MatchInningsSummary {
  team_id: string;
  runs_for: number;
  overs_faced: number; // decimal overs, e.g. 19.4 -> 19.667 normalized at compute time
  all_out: boolean;     // if all out, full quota of overs is used for NRR (cricket rule)
}

// ---- sport-agnostic config (S1: sports_sport_config) ----
export interface SportConfig {
  sport: string;
  // which scoring engine drives this sport:
  //   'ball_by_ball' -> the cricket innings/over engine (scoringEngine.ts)
  //   'period_points' -> the generic period-based scorer (genericScorer.ts)
  scoring_model: 'ball_by_ball' | 'period_points';
  stat_fields_json: {
    perf_fields: string[]; // which MatchPerformance fields apply
    leaderboard_sort: 'runs' | 'wickets' | 'points';
  };
  // cricket uses the ball-by-ball shape; generic sports use GenericRules (see genericScorer.ts).
  // kept as a loose record so both shapes validate; each engine narrows it.
  scoring_rules_json: Record<string, unknown> & {
    points_win: number;
    points_tie: number;
    points_loss: number;
    points_no_result: number;
  };
}
