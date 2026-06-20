// CW13 — verifier-facing agent-suggestions inbox (the 80/20 human action queue).
// Surfaces everything CW13's agents wrote to sports_agent_suggestions — the
// Verification AI agent's anomaly flags, committee decisions, squad records —
// in one place for a human to review and action.
//
// HARD RULE (honest-scope): actioning a suggestion is a HUMAN sign-off. It
// records who acted + the outcome; it never lets the agent self-resolve. The
// agent proposes, the human disposes.

import { listSuggestions, actionSuggestion, type AgentSuggestion } from './agent-repo';

export interface InboxItem extends AgentSuggestion {
  kind: string;          // pulled from payload for quick triage
  summary: string;       // human-readable one-liner
}

function summarize(s: AgentSuggestion): { kind: string; summary: string } {
  const p = (s.payload_json ?? {}) as any;
  const kind = p.kind ?? (s.agent === 'verification_ai' ? 'anomaly' : 'suggestion');
  if (kind === 'anomaly' || s.agent === 'verification_ai') {
    const risk = p.anomaly_risk?.value;
    const action = p.recommended_action ?? 'review';
    return { kind: 'anomaly', summary: `Verification ${s.subject_id}: ${action}${risk != null ? ` (risk ${Math.round(risk * 100)}%)` : ''}` };
  }
  if (kind === 'committee_decision') {
    return { kind: 'committee_decision', summary: `Committee: ${p.verdict} on athlete ${s.subject_id}` };
  }
  if (kind === 'squad') {
    return { kind: 'squad', summary: `Squad "${p.name}" (${p.members?.length ?? 0} players) for ${p.tournament || '—'}` };
  }
  return { kind, summary: `${s.agent} · ${s.subject_type} ${s.subject_id}` };
}

export async function inbox(filter?: { status?: string; highStakesOnly?: boolean }): Promise<InboxItem[]> {
  const rows = await listSuggestions(filter);
  return rows.map((s) => ({ ...s, ...summarize(s) }));
}

export async function action(id: string, actedBy: string, outcome: string): Promise<AgentSuggestion> {
  if (!actedBy) throw new Error('HUMAN_REQUIRED: an actor id is required to action a suggestion');
  if (!outcome) throw new Error('OUTCOME_REQUIRED: an outcome is required');
  return actionSuggestion(id, actedBy, outcome);
}
