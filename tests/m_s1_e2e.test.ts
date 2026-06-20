// tests/m_s1_e2e.test.ts
// M-S1 acceptance harness (CW16 owns the milestone gates).
// Asserts the Phase-1 loop on the frozen S2 ball-by-ball contract:
// academy -> players -> league -> ball-by-ball -> passport aggregation.
// DB-backed integration runs at deploy; here we prove the data CHAIN.
import { aggregatePerformance } from '../src/gateway/aggregate';
import { BallEvent } from '../src/types';

function ball(over: number, b: number, athlete: string, event: BallEvent['event'], runs?: number): BallEvent {
  return { match_id: 'M1', athlete_id: athlete, event, runs, ball: b, over, ts: new Date().toISOString() };
}

describe('M-S1: ball-by-ball -> passport aggregation', () => {
  const events: BallEvent[] = [
    ball(0, 1, 'A1', 'run', 4),
    ball(0, 2, 'A1', 'dot'),
    ball(0, 3, 'A1', 'run', 6),
    ball(0, 4, 'A1', 'run', 1),
    ball(0, 5, 'A1', 'wicket'),
    ball(0, 6, 'A1', 'extra'),
    ball(1, 1, 'A2', 'catch'), // fielding by another athlete
  ];

  it('aggregates A1 batting line correctly', () => {
    const p = aggregatePerformance('A1', events);
    expect(p.runs).toBe(11);     // 4 + 6 + 1
    expect(p.balls).toBe(4);     // run, dot, run, run (extra + wicket-ball excluded here)
    expect(p.fours).toBe(1);
    expect(p.sixes).toBe(1);
    expect(p.wickets).toBe(1);
    expect(p.source).toBe('match');
  });

  it('aggregates A2 fielding (catch) into its own row', () => {
    const p = aggregatePerformance('A2', events);
    expect(p.catches).toBe(1);
    expect(p.runs).toBe(0);
  });

  it('throws when an athlete has no events (no silent zero rows)', () => {
    expect(() => aggregatePerformance('GHOST', events)).toThrow();
  });
});
