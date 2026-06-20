// tests/trials_orchestration.test.ts
import { buildSelectionSuggestion, buildSelectionAlert } from '../src/routes/trials_orchestration';
import { isHighStakes } from '../src/agents/gate';

const outcome = {
  trial_id: 'T-1',
  athlete_id: 'ATH-9',
  league_or_trial_name: 'U16 State Trial',
  selected: true,
  recorded_by: 'verifier-3',
};

describe('trials -> selection orchestration (M-S3 seam)', () => {
  it('builds a high-stakes, pending selection suggestion', () => {
    const s = buildSelectionSuggestion(outcome);
    expect(s.subject_type).toBe('selection');
    expect(s.high_stakes).toBe(true);
    expect(s.status).toBe('pending');
    // gate independently agrees this is high-stakes
    expect(isHighStakes(s)).toBe(true);
  });

  it('emits a selection_result alert reflecting the outcome', () => {
    const alerts = buildSelectionAlert(outcome, '2026-06-19T12:00:00.000Z');
    const sel = alerts.find((a) => a.type === 'selection_result');
    expect(sel).toBeDefined();
    expect(sel!.message).toContain('Selected for U16 State Trial');
  });

  it('non-selection still produces an honest alert', () => {
    const alerts = buildSelectionAlert({ ...outcome, selected: false }, '2026-06-19T12:00:00.000Z');
    const sel = alerts.find((a) => a.type === 'selection_result');
    expect(sel!.message).toContain('Not selected');
  });
});
