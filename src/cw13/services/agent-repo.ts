// CW13 — agent_suggestions writer for the Verification AI agent (R4).
// Writes to sports_agent_suggestions via SERVICE_ROLE (CW16 owns the table;
// CW13 is one of the agents that writes to it). High-stakes suggestions carry
// high_stakes:true and NEVER take effect on their own — a human verifier must
// action them. Mock fallback keeps tests/dev network-free.

import { randomUUID } from 'node:crypto';
import { svc, supabaseConfigured } from '../lib/supabase';

export interface AgentSuggestion {
  id: string;
  agent: string;              // 'verification_ai'
  subject_type: string;       // entity_type
  subject_id: string;         // verification id
  payload_json: unknown;
  high_stakes: boolean;
  status: string;             // 'open' until a human actions it
  created_at: string;
}

const TABLE = 'sports_agent_suggestions';

// in-memory mirror so tests can assert what got written
export const suggestionsMock: AgentSuggestion[] = [];

export async function writeSuggestion(
  s: Omit<AgentSuggestion, 'id' | 'created_at' | 'status'> & { status?: string }
): Promise<AgentSuggestion> {
  const row: AgentSuggestion = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    status: s.status ?? 'open',
    ...s,
  };
  if (!supabaseConfigured || !svc) {
    suggestionsMock.push(row);
    return row;
  }
  const { data, error } = await svc.from(TABLE).insert(row).select().single();
  if (error) throw new Error('DB_SUGGESTION: ' + error.message);
  return data as AgentSuggestion;
}

// Read suggestions written by a given agent (verifier/admin/committee surfaces,
// service role). Optionally filter by a payload predicate done client-side.
export async function listByAgent(agent: string): Promise<AgentSuggestion[]> {
  if (!supabaseConfigured || !svc) {
    return suggestionsMock.filter((s) => s.agent === agent).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  const { data, error } = await svc
    .from(TABLE)
    .select('*')
    .eq('agent', agent)
    .order('created_at', { ascending: true });
  if (error) throw new Error('DB_LIST_AGENT: ' + error.message);
  return (data ?? []) as AgentSuggestion[];
}

// Inbox: all suggestions, optionally filtered by status and/or high_stakes.
// Verifier/admin surface (service role) — this is the 80/20 human action queue.
export async function listSuggestions(filter?: {
  status?: string;
  highStakesOnly?: boolean;
}): Promise<AgentSuggestion[]> {
  if (!supabaseConfigured || !svc) {
    let rows = suggestionsMock.slice();
    if (filter?.status) rows = rows.filter((s) => s.status === filter.status);
    if (filter?.highStakesOnly) rows = rows.filter((s) => s.high_stakes);
    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at)); // newest first
  }
  let q = svc.from(TABLE).select('*').order('created_at', { ascending: false });
  if (filter?.status) q = q.eq('status', filter.status);
  if (filter?.highStakesOnly) q = q.eq('high_stakes', true);
  const { data, error } = await q;
  if (error) throw new Error('DB_LIST_SUGG: ' + error.message);
  return (data ?? []) as AgentSuggestion[];
}

// Mark a suggestion actioned by a human (the 80/20 sign-off). Records who acted
// and the outcome in the payload, without losing the original agent payload.
export async function actionSuggestion(
  id: string,
  actedBy: string,
  outcome: string
): Promise<AgentSuggestion> {
  if (!supabaseConfigured || !svc) {
    const s = suggestionsMock.find((x) => x.id === id);
    if (!s) throw new Error('NOT_FOUND: suggestion ' + id);
    s.status = 'actioned';
    s.payload_json = { ...(s.payload_json as object), human_action: { acted_by: actedBy, outcome, acted_at: new Date().toISOString() } };
    return s;
  }
  const { data: existing } = await svc.from(TABLE).select('payload_json').eq('id', id).single();
  if (!existing) throw new Error('NOT_FOUND: suggestion ' + id);
  const merged = {
    ...((existing as any).payload_json ?? {}),
    human_action: { acted_by: actedBy, outcome, acted_at: new Date().toISOString() },
  };
  const { data, error } = await svc
    .from(TABLE)
    .update({ status: 'actioned', payload_json: merged })
    .eq('id', id)
    .select()
    .single();
  if (error || !data) throw new Error('DB_ACTION: ' + (error?.message ?? 'no row'));
  return data as AgentSuggestion;
}
