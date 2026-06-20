// src/routes/trials_orchestration.ts
// CW14 owns the Athlete->Trial->Scout->Selection seam. A selection outcome is
// a HIGH-STAKES, human-recorded fact. This helper turns it into:
//   1) a high-stakes agent_suggestion (pending — needs human action to take effect)
//   2) a selection_result alert
// Pure-ish: the suggestion shape + alert facts are built here and tested;
// persistence is the caller's (service role).
import { AgentSuggestion } from '../types';
import { evaluateAlerts, Alert } from '../alerts/engine';

export interface SelectionOutcome {
  trial_id: string;
  athlete_id: string;
  league_or_trial_name: string;
  selected: boolean;
  recorded_by: string; // human
}

/** Build the high-stakes suggestion for a selection. status stays pending;
 *  the human-action gate (agents/gate.ts) enforces it can't auto-take-effect. */
export function buildSelectionSuggestion(o: SelectionOutcome): Omit<AgentSuggestion, 'id' | 'created_at'> {
  return {
    agent: 'scout_agent',
    subject_type: 'selection',          // forces high_stakes via gate rules
    subject_id: o.athlete_id,
    payload_json: {
      trial_id: o.trial_id,
      selected: o.selected,
      recorded_by: o.recorded_by,
      name: o.league_or_trial_name,
    },
    high_stakes: true,
    status: 'pending',
  };
}

/** Build the selection_result alert facts for the engine. */
export function buildSelectionAlert(o: SelectionOutcome, now?: string): Alert[] {
  return evaluateAlerts({
    athlete_id: o.athlete_id,
    selection: { league: o.league_or_trial_name, selected: o.selected },
    now,
  });
}
