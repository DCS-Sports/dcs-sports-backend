// ─────────────────────────────────────────────────────────────────────────
// CW14 · HONEST-SCOPE GUARDS
//  - estimate(): the ONLY way CW14 emits an AI number. Never hand-build.
//  - rlsScoped(): documents that a query MUST run through CW9's DB RLS policy.
//    In the stub this is a marker; in real build it asserts the Supabase client
//    is the user-scoped (anon/JWT) client, never the service-role client.
// ─────────────────────────────────────────────────────────────────────────

import type { EstimateEnvelope } from './contracts';

export function estimate<T>(
  value: T,
  confidence: number,
  source: EstimateEnvelope['source'],
  model_version: string | null = null
): EstimateEnvelope<T> {
  return {
    value,
    confidence,
    estimate: true,
    source,
    model_version,
    generated_at: new Date().toISOString(),
    human_reviewed: false,
  };
}

// Marker used at every scout/search/discoverable read.
// Stub: returns the rows as-is from the mock (mock already simulates RLS).
// Real build: this MUST be the user-JWT-scoped Supabase client so Postgres RLS
// applies — CW14 never service-roles past the policy, never hand-filters in JS.
export const RLS_PASSTHROUGH = true as const;

// High-stakes guard: selection results / sponsor commitments require a human.
export function requiresHumanAction(decided_by: string | null): boolean {
  return decided_by === null;
}
