// tests/gate.test.ts
import { isHighStakes } from '../src/agents/gate';

describe('high-stakes human-action gate (classification)', () => {
  it('flags verification_agent as high-stakes regardless of subject', () => {
    expect(isHighStakes({ agent: 'verification_agent', subject_type: 'athlete' })).toBe(true);
  });

  it('flags payouts and selections as high-stakes', () => {
    expect(isHighStakes({ subject_type: 'payout' })).toBe(true);
    expect(isHighStakes({ subject_type: 'selection' })).toBe(true);
  });

  it('flags scout selection suggestions as high-stakes', () => {
    expect(isHighStakes({ agent: 'scout_agent', subject_type: 'selection' })).toBe(true);
  });

  it('does NOT flag a routine athlete-agent alert', () => {
    expect(isHighStakes({ agent: 'athlete_agent', subject_type: 'reminder' })).toBe(false);
  });
});
