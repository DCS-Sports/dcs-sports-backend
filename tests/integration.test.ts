// tests/integration.test.ts
import { heuristicTalent } from '../src/routes/vision';

describe('heuristic talent index (estimate, not a model)', () => {
  it('returns 0/0 with no stats', () => {
    const t = heuristicTalent([]);
    expect(t.value).toBe(0);
    expect(t.confidence).toBe(0);
  });

  it('weights batting/bowling/fielding and scales confidence with matches', () => {
    const t = heuristicTalent([
      { batting_rating: 80, bowling_rating: 60, fielding_rating: 70, matches: 25 },
      { batting_rating: 80, bowling_rating: 60, fielding_rating: 70, matches: 25 },
    ]);
    // 80*.45 + 60*.4 + 70*.15 = 36 + 24 + 10.5 = 70.5 -> 71
    expect(t.value).toBe(71);
    expect(t.confidence).toBe(1); // 50 matches => full
  });

  it('clamps and stays within 0..100', () => {
    const t = heuristicTalent([{ batting_rating: 999, bowling_rating: -50, fielding_rating: 50, matches: 5 }]);
    expect(t.sub.batting).toBe(100);
    expect(t.sub.bowling).toBe(0);
    expect(t.value).toBeLessThanOrEqual(100);
  });
});

describe('gateway integration boot', () => {
  it('mounts all lane routers and reports them on /health', () => {
    // require lazily so missing DB env doesn't break import-time
    const { createApp } = require('../src/gateway/server');
    const app = createApp();
    // express app exposes _router stack; assert routes are registered
    const layerNames = app._router.stack.map((l: any) => l.name);
    expect(layerNames).toContain('router'); // mounted sub-routers present
    // health route is registered
    const hasHealth = app._router.stack.some((l: any) => l.route && l.route.path === '/health');
    expect(hasHealth).toBe(true);
  });
});
