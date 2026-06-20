// CW12 — ball-by-ball scoring state machine.
// Ingests S2-frozen ScoreEvents, validates them against the sport's rules,
// advances innings/over/ball state, and aggregates into sports_match_performances
// (source='match' always). This is the data factory that feeds CW10 passport,
// CW14 scout, CW15 talent.

import type {
  ScoreEvent,
  MatchPerformance,
  SportConfig,
  MatchInningsSummary,
} from '../types/index';
import { getSportConfig } from './sportConfig';

// cricket-specific rules shape (narrows the loose scoring_rules_json for the ball-by-ball engine)
interface CricketRules {
  legal_balls_per_over: number;
  extras_are_legal: Partial<Record<string, boolean>>;
}
function cricketRules(sport: string): CricketRules {
  const r = getSportConfig(sport).scoring_rules_json as unknown as CricketRules;
  return r;
}

export interface InningsState {
  innings: number;
  over: number; // completed legal overs
  ball: number; // legal balls bowled in the current over (0..legal_balls_per_over)
  total_runs: number;
  total_wickets: number;
}

export interface MatchScoringState {
  match_id: string;
  sport: string;
  current_innings: number;
  innings: Record<number, InningsState>;
  // aggregate keyed by athlete_id -> partial performance
  performances: Record<string, MatchPerformance>;
  events: ScoreEvent[]; // append-only event log (mirrors sports_live_scores)
  seq: number;          // monotonic event counter (the authoritative sequence)
  seenKeys: string[];   // client idempotency keys already applied (dedupe on reconnect)
}

export function newMatchState(match_id: string, sport: string): MatchScoringState {
  return {
    match_id,
    sport,
    current_innings: 1,
    innings: { 1: blankInnings(1) },
    performances: {},
    events: [],
    seq: 0,
    seenKeys: [],
  };
}

function blankInnings(n: number): InningsState {
  return { innings: n, over: 0, ball: 0, total_runs: 0, total_wickets: 0 };
}

function perfFor(state: MatchScoringState, athlete_id: string): MatchPerformance {
  if (!state.performances[athlete_id]) {
    state.performances[athlete_id] = {
      match_id: state.match_id,
      athlete_id,
      runs: 0, balls: 0, fours: 0, sixes: 0,
      overs: 0, wickets: 0, runs_conceded: 0, catches: 0,
      source: 'match',
    };
  }
  return state.performances[athlete_id];
}

export class ScoringError extends Error {}

/**
 * Apply one ScoreEvent. Validates → mutates state → updates aggregate.
 * Returns the updated InningsState. Throws ScoringError on contract violations
 * (fail-closed: a bad event never silently corrupts the aggregate).
 */
export function applyEvent(state: MatchScoringState, ev: ScoreEvent): InningsState {
  if (ev.match_id !== state.match_id) {
    throw new ScoringError(`event match_id ${ev.match_id} != state ${state.match_id}`);
  }
  const cfg: SportConfig = getSportConfig(state.sport);
  const rules = cricketRules(state.sport);
  const innNo = ev.innings ?? state.current_innings;
  if (!state.innings[innNo]) state.innings[innNo] = blankInnings(innNo);
  const inn = state.innings[innNo];
  state.current_innings = innNo;

  const legalPerOver = rules.legal_balls_per_over;
  const isLegal = rules.extras_are_legal[ev.event] !== false
    && ev.event !== 'wide'
    && ev.event !== 'no_ball';

  switch (ev.event) {
    case 'run':
    case 'dot':
    case 'bye':
    case 'leg_bye': {
      const runs = ev.runs ?? (ev.event === 'dot' ? 0 : 0);
      inn.total_runs += runs;
      const bat = perfFor(state, ev.athlete_id);
      // byes/leg-byes count as a ball faced but not runs to the striker
      if (ev.event === 'run' || ev.event === 'dot') {
        bat.runs += runs;
        bat.balls += 1;
        if (ev.boundary === 4 || runs === 4) bat.fours += 1;
        if (ev.boundary === 6 || runs === 6) bat.sixes += 1;
      } else {
        bat.balls += 1; // faced the ball, runs are extras
      }
      // concede to bowler if known
      if (ev.bowler_id) perfFor(state, ev.bowler_id).runs_conceded += runs;
      break;
    }
    case 'wide':
    case 'no_ball': {
      const runs = (ev.runs ?? 0) + 1; // 1 penalty + any runs run
      inn.total_runs += runs;
      if (ev.bowler_id) perfFor(state, ev.bowler_id).runs_conceded += runs;
      break; // does NOT advance the legal-ball count
    }
    case 'wicket': {
      inn.total_wickets += 1;
      // wicket credited to bowler unless run-out
      const bowler = ev.bowler_id ?? ev.athlete_id;
      if (ev.dismissal !== 'run_out') perfFor(state, bowler).wickets += 1;
      if (ev.dismissed_id) perfFor(state, ev.dismissed_id).balls += 1; // faced the ball
      if (ev.dismissal === 'caught' && ev.fielder_id) {
        perfFor(state, ev.fielder_id).catches += 1;
      }
      break;
    }
    case 'catch': {
      perfFor(state, ev.fielder_id ?? ev.athlete_id).catches += 1;
      break;
    }
    default:
      throw new ScoringError(`unknown event type: ${(ev as ScoreEvent).event}`);
  }

  // advance ball/over state on legal deliveries only
  if (isLegal) {
    inn.ball += 1;
    if (inn.ball >= legalPerOver) {
      inn.over += 1;
      inn.ball = 0;
      // credit the bowler an over
      if (ev.bowler_id) perfFor(state, ev.bowler_id).overs += 1;
    }
  }

  state.events.push(ev);
  state.seq += 1;
  return inn;
}

// ── conflict handling for live scoring (reconnect-safe) ──
export type ScoreApplyOutcome =
  | { status: 'applied'; seq: number; innings: InningsState }
  | { status: 'duplicate'; seq: number } // idempotency key already seen — safe no-op
  | { status: 'conflict'; seq: number; expected: number }; // optimistic-concurrency mismatch

/**
 * Apply a score event with reconnect-safe conflict handling.
 *  - idempotency_key: if already seen, returns 'duplicate' (no double-count) — this is what
 *    makes a scorer's retry-after-reconnect safe.
 *  - expected_seq (optional): optimistic concurrency. If provided and != current seq, returns
 *    'conflict' so a stale client (two scorers) re-syncs instead of clobbering.
 * On success the key is recorded and the event applied.
 */
export function applyEventSafe(
  state: MatchScoringState,
  ev: ScoreEvent,
  opts: { idempotency_key?: string; expected_seq?: number } = {},
): ScoreApplyOutcome {
  const { idempotency_key, expected_seq } = opts;
  if (idempotency_key && state.seenKeys.includes(idempotency_key)) {
    return { status: 'duplicate', seq: state.seq };
  }
  if (expected_seq !== undefined && expected_seq !== state.seq) {
    return { status: 'conflict', seq: state.seq, expected: expected_seq };
  }
  const innings = applyEvent(state, ev); // may throw ScoringError on bad event (caller handles)
  if (idempotency_key) {
    state.seenKeys.push(idempotency_key);
    if (state.seenKeys.length > 500) state.seenKeys = state.seenKeys.slice(-500); // bound memory
  }
  return { status: 'applied', seq: state.seq, innings };
}

/** Replay an event log from scratch — used to rebuild aggregates idempotently. */
export function replay(match_id: string, sport: string, events: ScoreEvent[]): MatchScoringState {
  const state = newMatchState(match_id, sport);
  for (const ev of events) applyEvent(state, ev);
  return state;
}

/** Flatten the aggregate to the rows CW10/CW14 read. */
export function toPerformanceRows(state: MatchScoringState): MatchPerformance[] {
  return Object.values(state.performances);
}

/**
 * Build per-team innings summaries for NRR, mapping each innings to its batting team.
 * innings 1 = home batting, innings 2 = away batting (the scorer's innings convention).
 * overs_faced is expressed in cricket decimal (over.ball, e.g. 19.4).
 */
export function buildInningsSummary(
  state: MatchScoringState,
  home_team_id: string,
  away_team_id: string,
  wicketsForAllOut = 10,
): MatchInningsSummary[] {
  const out: MatchInningsSummary[] = [];
  const teamFor = (inn: number) => (inn === 1 ? home_team_id : away_team_id);
  for (const inn of Object.values(state.innings)) {
    out.push({
      team_id: teamFor(inn.innings),
      runs_for: inn.total_runs,
      overs_faced: inn.over + inn.ball / 10, // decimal-over notation
      all_out: inn.total_wickets >= wicketsForAllOut,
    });
  }
  return out;
}
