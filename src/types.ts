// src/types.ts
// Frozen contracts from DAY-0 MANAGER REPLY (S4). Do not drift these shapes.
// Every AI numeric output in DCS Sports ships the EstimateEnvelope.

export type EstimateSource = 'vision' | 'talent' | 'coach_ai' | 'scout_ai';

/** S4 — frozen estimate envelope. CW16's extra fields (model_version,
 *  generated_at, human_reviewed) are accepted + frozen by the manager. */
export interface EstimateEnvelope {
  value: number;
  confidence: number;        // 0..1
  estimate: true;            // literal — never false; absence of validation
  source: EstimateSource;
  model_version: string | null;
  generated_at: string;      // ISO 8601
  human_reviewed: boolean;
}

export type AgentName =
  | 'athlete_agent'
  | 'scout_agent'
  | 'sponsor_agent'
  | 'coach_agent'
  | 'verification_agent';

export type SuggestionStatus = 'pending' | 'actioned' | 'dismissed' | 'expired';

/** Row written to sports_agent_suggestions.
 *  high_stakes:true (selections, verifications, payouts) REQUIRES a human
 *  action before it takes effect — the gate lives in agents/gate.ts. */
export interface AgentSuggestion {
  id?: string;
  agent: AgentName;
  subject_type: string;      // 'athlete' | 'match' | 'trial' | ...
  subject_id: string;
  payload_json: Record<string, unknown>;
  high_stakes: boolean;
  status: SuggestionStatus;
  created_at?: string;
}

export type RevenueSource = 'subscription' | 'trial_fee' | 'sponsor_deal' | 'academy_fee';

/** Row written to sports_revenue_events. mode is ALWAYS 'test' until DK
 *  flips money. splits_json carries the computed split — no money moves. */
export interface RevenueEvent {
  id?: string;
  source: RevenueSource;
  athlete_id: string | null;
  gross: number;             // minor units (paise)
  splits_json: RevenueSplit;
  mode: 'test' | 'live';     // CW16 only ever writes 'test'
}

export interface RevenueSplit {
  athlete: number;
  academy: number;
  agent: number;
  dcs: number;
  // sum of the four === gross (invariant asserted in revenue/splits.ts)
}

/** S2 — ball-by-ball event shape (CW12 emits, CW10 aggregates).
 *  CW16's M-S1 harness asserts the full chain on this contract. */
export interface BallEvent {
  match_id: string;
  athlete_id: string;
  event: 'run' | 'wicket' | 'catch' | 'extra' | 'dot';
  runs?: number;
  ball: number;
  over: number;
  ts: string;                // ISO 8601
}
