// src/agents/gate.ts
// The human-action gate (S4). High-stakes AI suggestions — selections,
// verifications, payouts — are WRITTEN as pending and require an explicit
// human action before they take effect. 80% AI / 20% human, enforced here.
import { AgentSuggestion, AgentName } from '../types';
import { getServiceClient } from '../db/supabase';

/** Subject/agent combinations that are inherently high-stakes regardless of
 *  what the caller passes. We force high_stakes:true so no agent can sneak a
 *  consequential suggestion through as low-stakes. */
const HIGH_STAKES_RULES: Array<(s: Partial<AgentSuggestion>) => boolean> = [
  (s) => s.agent === 'verification_agent',
  (s) => s.agent === 'scout_agent' && s.subject_type === 'selection',
  (s) => s.subject_type === 'payout',
  (s) => s.subject_type === 'selection',
];

export function isHighStakes(s: Partial<AgentSuggestion>): boolean {
  return HIGH_STAKES_RULES.some((rule) => rule(s));
}

/** Write a suggestion. high_stakes is computed defensively (caller value OR
 *  any rule match). Status is ALWAYS 'pending' on write — taking effect is a
 *  separate, human-initiated action (see actionSuggestion). */
export async function writeSuggestion(input: {
  agent: AgentName;
  subject_type: string;
  subject_id: string;
  payload_json: Record<string, unknown>;
  high_stakes?: boolean;
}): Promise<AgentSuggestion> {
  const high_stakes = Boolean(input.high_stakes) || isHighStakes(input);
  const row: AgentSuggestion = {
    agent: input.agent,
    subject_type: input.subject_type,
    subject_id: input.subject_id,
    payload_json: input.payload_json,
    high_stakes,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  const sb = getServiceClient();
  const { data, error } = await sb.from('sports_agent_suggestions').insert(row).select().single();
  if (error) throw new Error(`[agents] write failed: ${error.message}`);
  return data as AgentSuggestion;
}

/** Apply a suggestion. For high_stakes rows this MUST carry a human actor id;
 *  refuses otherwise. This is the gate — code cannot self-authorize. */
export async function actionSuggestion(
  suggestionId: string,
  actor: { user_id: string; is_human: boolean }
): Promise<{ ok: true }> {
  const sb = getServiceClient();
  const { data, error } = await sb
    .from('sports_agent_suggestions')
    .select('*')
    .eq('id', suggestionId)
    .single();
  if (error || !data) throw new Error(`[agents] suggestion ${suggestionId} not found`);
  const s = data as AgentSuggestion;

  if (s.high_stakes && !actor.is_human) {
    throw new Error(
      `[agents] BLOCKED: high-stakes suggestion ${suggestionId} requires a HUMAN action. ` +
        'No autonomous actor may take effect on selections/verifications/payouts.'
    );
  }
  const { error: upErr } = await sb
    .from('sports_agent_suggestions')
    .update({ status: 'actioned' })
    .eq('id', suggestionId);
  if (upErr) throw new Error(`[agents] action failed: ${upErr.message}`);
  return { ok: true };
}
