// CW12 — commentary feed + scorecard (Match Center deepening, go-live block).
// Both derive from the scoring state / event log. Commentary is deterministic
// templating over real events (no AI, no fabrication). Scorecard is the standard
// batting + bowling card aggregated from sports_match_performances + the event log.

import type { ScoreEvent, MatchPerformance } from '../types/index';
import type { MatchScoringState } from './scoringEngine';

export interface CommentaryLine {
  over_ball: string;      // "4.3"
  innings: number;
  text: string;
  kind: 'run' | 'boundary' | 'wicket' | 'extra' | 'milestone';
  ts: string;
}

const ORDINAL_BOUNDARY: Record<number, string> = { 4: 'FOUR', 6: 'SIX' };

/** One human-readable commentary line for a single event. Deterministic. */
export function lineForEvent(ev: ScoreEvent): CommentaryLine {
  const ob = `${ev.over}.${ev.ball}`;
  const base = { over_ball: ob, innings: ev.innings ?? 1, ts: ev.ts };

  if (ev.event === 'wicket') {
    const how = ev.dismissal ? ev.dismissal.replace('_', ' ') : 'out';
    const who = ev.dismissed_id ?? 'batter';
    return { ...base, kind: 'wicket', text: `WICKET! ${who} ${how}${ev.bowler_id ? ` b ${ev.bowler_id}` : ''}.` };
  }
  if (ev.event === 'wide') return { ...base, kind: 'extra', text: `Wide down the side, +${1 + (ev.runs ?? 0)}.` };
  if (ev.event === 'no_ball') return { ...base, kind: 'extra', text: `No ball — free hit coming, +${1 + (ev.runs ?? 0)}.` };
  if (ev.event === 'bye') return { ...base, kind: 'extra', text: `${ev.runs ?? 0} bye(s).` };
  if (ev.event === 'leg_bye') return { ...base, kind: 'extra', text: `${ev.runs ?? 0} leg bye(s).` };

  const runs = ev.runs ?? 0;
  if (runs === 4 || runs === 6 || ev.boundary) {
    const word = ORDINAL_BOUNDARY[ev.boundary ?? runs] ?? `${runs}`;
    return { ...base, kind: 'boundary', text: `${word}! ${ev.athlete_id} times it beautifully.` };
  }
  if (runs === 0) return { ...base, kind: 'run', text: `Dot ball. Good length, defended.` };
  return { ...base, kind: 'run', text: `${runs} run${runs > 1 ? 's' : ''} to ${ev.athlete_id}.` };
}

/** Build the full commentary feed (most-recent-first) from the event log. */
export function buildCommentary(state: MatchScoringState, limit = 30): CommentaryLine[] {
  const lines = state.events.map(lineForEvent);
  // milestone insertion: 50s/100s per batter (counted from aggregate)
  return lines.slice().reverse().slice(0, limit);
}

// ---- scorecard ----
export interface BattingCardRow {
  athlete_id: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  strike_rate: number;
  out: boolean;
}
export interface BowlingCardRow {
  athlete_id: string;
  overs: number;
  runs_conceded: number;
  wickets: number;
  economy: number;
}
export interface Scorecard {
  match_id: string;
  batting: BattingCardRow[];
  bowling: BowlingCardRow[];
}

/** Build batting + bowling cards from the match performance aggregate. */
export function buildScorecard(match_id: string, perfs: MatchPerformance[], dismissed: Set<string> = new Set()): Scorecard {
  const batting: BattingCardRow[] = perfs
    .filter((p) => p.balls > 0 || p.runs > 0)
    .map((p) => ({
      athlete_id: p.athlete_id,
      runs: p.runs, balls: p.balls, fours: p.fours, sixes: p.sixes,
      strike_rate: p.balls > 0 ? +((p.runs / p.balls) * 100).toFixed(2) : 0,
      out: dismissed.has(p.athlete_id),
    }))
    .sort((a, b) => b.runs - a.runs);

  const bowling: BowlingCardRow[] = perfs
    .filter((p) => p.overs > 0 || p.wickets > 0 || p.runs_conceded > 0)
    .map((p) => ({
      athlete_id: p.athlete_id,
      overs: p.overs, runs_conceded: p.runs_conceded, wickets: p.wickets,
      economy: p.overs > 0 ? +(p.runs_conceded / p.overs).toFixed(2) : 0,
    }))
    .sort((a, b) => b.wickets - a.wickets || a.runs_conceded - b.runs_conceded);

  return { match_id, batting, bowling };
}

/** Pull the set of dismissed athlete ids from the event log (for the batting card's out flag). */
export function dismissedFrom(state: MatchScoringState): Set<string> {
  const out = new Set<string>();
  for (const e of state.events) {
    if (e.event === 'wicket' && e.dismissed_id) out.add(e.dismissed_id);
  }
  return out;
}
