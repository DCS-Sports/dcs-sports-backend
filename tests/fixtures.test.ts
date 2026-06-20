// tests/fixtures.test.ts
import { roundRobin, knockout, generateFixtures } from '../src/routes/fixtures';

describe('fixture generation', () => {
  it('round-robin: 4 teams => 6 unique matches, 3 rounds', () => {
    const f = roundRobin(['A', 'B', 'C', 'D']);
    expect(f).toHaveLength(6);
    expect(new Set(f.map((x) => x.round)).size).toBe(3);
    // every pair appears exactly once (order-insensitive)
    const pairs = new Set(f.map((x) => [x.home_team_id, x.away_team_id].sort().join('-')));
    expect(pairs.size).toBe(6);
  });

  it('round-robin: odd teams drop BYE matches', () => {
    const f = roundRobin(['A', 'B', 'C']);
    expect(f.every((x) => x.home_team_id !== 'BYE' && x.away_team_id !== 'BYE')).toBe(true);
  });

  it('knockout: 8 teams => 4 first-round matches', () => {
    expect(knockout(['1', '2', '3', '4', '5', '6', '7', '8'])).toHaveLength(4);
  });

  it('unknown format throws', () => {
    expect(() => generateFixtures('mystery', ['A', 'B'])).toThrow();
  });
});
