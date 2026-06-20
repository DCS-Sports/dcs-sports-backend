// tests/agent_tick.test.ts
import { athleteAgentScan, coachAgentScan, scoutAgentScan, runTick } from '../src/agents/tick';
import { isHighStakes } from '../src/agents/gate';

const NOW = new Date('2026-06-19T12:00:00.000Z');

describe('athlete_agent scan', () => {
  it('fires match_prep within 48h', () => {
    const out = athleteAgentScan([{ athlete_id: 'A1', next_match_at: '2026-06-20T12:00:00.000Z' }], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].payload_json.kind).toBe('match_prep');
    expect(out[0].high_stakes).toBe(false);
  });

  it('fires re_engage after 14+ inactive days', () => {
    const out = athleteAgentScan([{ athlete_id: 'A1', last_active_days: 20 }], NOW);
    expect(out.some((s) => s.payload_json.kind === 're_engage')).toBe(true);
  });

  it('stays quiet with no triggers', () => {
    expect(athleteAgentScan([{ athlete_id: 'A1', last_active_days: 2 }], NOW)).toHaveLength(0);
  });
});

describe('coach_agent scan', () => {
  it('flags a >=15% form drop', () => {
    const out = coachAgentScan([{ athlete_id: 'A1', recent_avg: 40, baseline_avg: 50 }]);
    expect(out).toHaveLength(1);
    expect(out[0].payload_json.kind).toBe('form_drop');
    expect(out[0].payload_json.drop_pct).toBe(0.2);
  });

  it('ignores a small dip', () => {
    expect(coachAgentScan([{ athlete_id: 'A1', recent_avg: 48, baseline_avg: 50 }])).toHaveLength(0);
  });
});

describe('scout_agent scan', () => {
  it('emits high-stakes pending suggestions for selections', () => {
    const out = scoutAgentScan([{ trial_id: 'T1', athlete_id: 'A1', selected: true, recorded_by: 'v1' }]);
    expect(out).toHaveLength(1);
    expect(out[0].high_stakes).toBe(true);
    expect(out[0].status).toBe('pending');
    expect(isHighStakes(out[0])).toBe(true); // gate agrees
  });

  it('ignores non-selections', () => {
    expect(scoutAgentScan([{ trial_id: 'T1', athlete_id: 'A1', selected: false, recorded_by: 'v1' }])).toHaveLength(0);
  });
});

describe('runTick composition', () => {
  it('combines all agent outputs', () => {
    const out = runTick({
      athletes: [{ athlete_id: 'A1', next_match_at: '2026-06-20T12:00:00.000Z', recent_avg: 40, baseline_avg: 50 }],
      selections: [{ trial_id: 'T1', athlete_id: 'A1', selected: true, recorded_by: 'v1' }],
      now: NOW,
    });
    // match_prep + form_drop + selection = 3
    expect(out).toHaveLength(3);
    expect(out.filter((s) => s.high_stakes)).toHaveLength(1);
  });
});
