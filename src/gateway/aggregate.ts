// src/gateway/aggregate.ts
// M-S1 core: fold CW12 ball-by-ball events into a sports_match_performances
// row that CW10's passport reads. Pure reducer — the harness asserts on this.
import { BallEvent } from '../types';

export interface MatchPerformance {
  match_id: string;
  athlete_id: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  wickets: number;
  catches: number;
  source: 'match';
}

export function aggregatePerformance(athleteId: string, events: BallEvent[]): MatchPerformance {
  const mine = events.filter((e) => e.athlete_id === athleteId);
  if (mine.length === 0) {
    throw new Error(`[aggregate] no events for athlete ${athleteId}`);
  }
  const matchId = mine[0].match_id;
  const perf: MatchPerformance = {
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
  for (const e of mine) {
    switch (e.event) {
      case 'run': {
        const r = e.runs ?? 0;
        perf.runs += r;
        perf.balls += 1;
        if (r === 4) perf.fours += 1;
        if (r === 6) perf.sixes += 1;
        break;
      }
      case 'dot':
        perf.balls += 1;
        break;
      case 'wicket':
        perf.wickets += 1;
        break;
      case 'catch':
        perf.catches += 1;
        break;
      case 'extra':
        // extras don't count as a ball faced by the striker
        break;
    }
  }
  return perf;
}
