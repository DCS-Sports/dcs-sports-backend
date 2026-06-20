// tests/revenue.test.ts
import { computeSplit, buildRevenueEvent, DEFAULT_SPLIT } from '../src/revenue/splits';

describe('revenue splits (DARK / test mode)', () => {
  it('splits 70/15/10/5 and sums exactly to gross', () => {
    const s = computeSplit(10000); // ₹100 in paise
    expect(s.athlete).toBe(7000);
    expect(s.academy).toBe(1500);
    expect(s.agent).toBe(1000);
    expect(s.dcs).toBe(500);
    expect(s.athlete + s.academy + s.agent + s.dcs).toBe(10000);
  });

  it('sweeps floor remainder to DCS so invariant always holds', () => {
    const s = computeSplit(10001);
    expect(s.athlete + s.academy + s.agent + s.dcs).toBe(10001);
  });

  it('rejects non-integer / negative gross', () => {
    expect(() => computeSplit(99.5)).toThrow();
    expect(() => computeSplit(-1)).toThrow();
  });

  it('rejects ratios that do not sum to 1.0', () => {
    expect(() => computeSplit(10000, { athlete: 0.5, academy: 0.2, agent: 0.2, dcs: 0.2 })).toThrow();
  });

  it('every built event is mode=test (money DARK at the type level)', () => {
    const e = buildRevenueEvent('subscription', 'A1', 49900, DEFAULT_SPLIT);
    expect(e.mode).toBe('test');
  });
});
