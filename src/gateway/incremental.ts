// src/gateway/incremental.ts
// Incremental performance fold: apply ONE ball to an existing performance,
// O(1) per ball. Replaces the O(n) full re-read+re-aggregate on every score
// event — the scaling fix for live matches (240+ balls). Same result as
// aggregatePerformance run over all events, computed incrementally.
import { BallEvent } from '../types';
import { MatchPerformance } from './aggregate';

export function emptyPerformance(matchId: string, athleteId: string): MatchPerformance {
  return {
    match_id: matchId,
    athlete_id: athleteId,
    runs: 0,
    balls: 0,
    fours: 0,
    sixes: 0,
    wickets: 0,
    catches: 0,
    source: 'match',
  };
}

/** Apply a single ball event to a performance, returning a new performance.
 *  Mirrors the switch in aggregatePerformance exactly so incremental == batch. */
export function applyBall(perf: MatchPerformance, e: BallEvent): MatchPerformance {
  const p = { ...perf };
  switch (e.event) {
    case 'run': {
      const r = e.runs ?? 0;
      p.runs += r;
      p.balls += 1;
      if (r === 4) p.fours += 1;
      if (r === 6) p.sixes += 1;
      break;
    }
    case 'dot':
      p.balls += 1;
      break;
    case 'wicket':
      p.wickets += 1;
      break;
    case 'catch':
      p.catches += 1;
      break;
    case 'extra':
      break;
  }
  return p;
}
