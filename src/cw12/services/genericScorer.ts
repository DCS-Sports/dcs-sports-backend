// CW12 — generic multi-sport scorer (sport-agnostic proof, R5 multi-sport prep).
//
// PROOF GOAL: adding a new sport = adding a sports_sport_config row + a small event->stat
// mapping, with ZERO changes to fixtures, standings sorting, routes, or the data-factory
// contract. Cricket keeps its dedicated ball-by-ball engine (scoringEngine.ts) because it
// has the richest model (over/ball/innings). Football, Kabaddi, and anything else flow
// through this generic period-based scorer.
//
// Both paths converge on the same output shape: per-athlete stat lines + a team score,
// so passports/leaderboards/standings consume one contract regardless of sport.

import type { ScoreEvent } from '../types/index';
import { getSportConfig } from './sportConfig';

// Generic event for non-cricket sports. event names are sport-defined (in config);
// the engine treats them as opaque stat-bearing events.
export interface GenericScoreEvent {
  match_id: string;
  athlete_id: string;
  team_id: string;
  event: string;          // 'goal' | 'assist' | 'raid_point' | 'tackle_point' | ...
  points?: number;        // points this event adds to the team score (default from config)
  period: number;         // half / inning / time-bucket
  ts: string;
  // optional context, opaque to the engine
  assist_id?: string;
  meta?: Record<string, unknown>;
}

export interface GenericAthleteLine {
  athlete_id: string;
  team_id: string;
  stats: Record<string, number>; // sport-defined stat tallies, e.g. {goals:2, assists:1}
  points_contributed: number;
}

export interface GenericMatchState {
  match_id: string;
  sport: string;
  team_scores: Record<string, number>;     // team_id -> score
  period_scores: Record<number, Record<string, number>>; // period -> team_id -> score
  athletes: Record<string, GenericAthleteLine>;
  current_period: number;
  events: GenericScoreEvent[];
}

export class GenericScoringError extends Error {}

export function newGenericState(match_id: string, sport: string): GenericMatchState {
  return {
    match_id, sport,
    team_scores: {},
    period_scores: {},
    athletes: {},
    current_period: 1,
    events: [],
  };
}

function lineFor(state: GenericMatchState, athlete_id: string, team_id: string): GenericAthleteLine {
  if (!state.athletes[athlete_id]) {
    state.athletes[athlete_id] = { athlete_id, team_id, stats: {}, points_contributed: 0 };
  }
  return state.athletes[athlete_id];
}

/**
 * Apply a generic event. The sport's config declares its valid events and the default
 * points each event scores. Unknown events fail closed (never silently mis-score).
 */
export function applyGenericEvent(state: GenericMatchState, ev: GenericScoreEvent): GenericMatchState {
  if (ev.match_id !== state.match_id) {
    throw new GenericScoringError(`event match_id ${ev.match_id} != state ${state.match_id}`);
  }
  const cfg = getSportConfig(state.sport);
  const rules = cfg.scoring_rules_json as unknown as GenericRules;
  const eventDef = rules.events?.[ev.event];
  if (!eventDef) {
    throw new GenericScoringError(`event "${ev.event}" not defined for sport "${state.sport}"`);
  }

  const period = ev.period ?? state.current_period;
  state.current_period = period;
  const points = ev.points ?? eventDef.points ?? 0;

  // team score
  state.team_scores[ev.team_id] = (state.team_scores[ev.team_id] ?? 0) + points;
  (state.period_scores[period] ??= {});
  state.period_scores[period][ev.team_id] = (state.period_scores[period][ev.team_id] ?? 0) + points;

  // athlete stat tally
  const line = lineFor(state, ev.athlete_id, ev.team_id);
  line.stats[eventDef.stat] = (line.stats[eventDef.stat] ?? 0) + 1;
  line.points_contributed += points;

  // assist credit (if the event grants one and an assist_id is present)
  if (eventDef.assist_stat && ev.assist_id) {
    const a = lineFor(state, ev.assist_id, ev.team_id);
    a.stats[eventDef.assist_stat] = (a.stats[eventDef.assist_stat] ?? 0) + 1;
  }

  state.events.push(ev);
  return state;
}

export function replayGeneric(match_id: string, sport: string, events: GenericScoreEvent[]): GenericMatchState {
  const s = newGenericState(match_id, sport);
  for (const ev of events) applyGenericEvent(s, ev);
  return s;
}

/** Decide a result from team scores (higher wins; equal = tie). Returns team_id | 'tie'. */
export function genericResult(state: GenericMatchState): string {
  const entries = Object.entries(state.team_scores);
  if (entries.length < 2) return 'no_result';
  entries.sort((a, b) => b[1] - a[1]);
  if (entries[0][1] === entries[1][1]) return 'tie';
  return entries[0][0];
}

// ---- the rules shape generic sports declare in sports_sport_config.scoring_rules_json ----
export interface GenericRules {
  periods: number;                 // halves (2), or innings, etc.
  events: Record<string, { stat: string; points: number; assist_stat?: string }>;
  points_win: number;
  points_tie: number;
  points_loss: number;
  points_no_result: number;
}
