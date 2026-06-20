// tests/alerts.test.ts
import { evaluateAlerts } from '../src/alerts/engine';

const NOW = '2026-06-19T12:00:00.000Z';

describe('alerts engine v1', () => {
  it('fires absent_today only when present_today is false', () => {
    expect(evaluateAlerts({ athlete_id: 'A1', present_today: false, now: NOW })[0].type).toBe('absent_today');
    expect(evaluateAlerts({ athlete_id: 'A1', present_today: true, now: NOW })).toHaveLength(0);
  });

  it('fires perf_drop on >=15% relative drop', () => {
    const a = evaluateAlerts({ athlete_id: 'A1', recent_avg: 40, baseline_avg: 50, now: NOW });
    expect(a.some((x) => x.type === 'perf_drop')).toBe(true);
    const b = evaluateAlerts({ athlete_id: 'A1', recent_avg: 48, baseline_avg: 50, now: NOW });
    expect(b.some((x) => x.type === 'perf_drop')).toBe(false);
  });

  it('fires upcoming_match within 24h only', () => {
    const soon = evaluateAlerts({ athlete_id: 'A1', next_match_at: '2026-06-20T06:00:00.000Z', now: NOW });
    expect(soon.some((x) => x.type === 'upcoming_match')).toBe(true);
    const later = evaluateAlerts({ athlete_id: 'A1', next_match_at: '2026-06-25T06:00:00.000Z', now: NOW });
    expect(later.some((x) => x.type === 'upcoming_match')).toBe(false);
  });

  it('fires selection_result both ways', () => {
    const sel = evaluateAlerts({ athlete_id: 'A1', selection: { league: 'U16 State', selected: true }, now: NOW });
    expect(sel[0].message).toContain('Selected');
  });
});
