// CW14 · SEAM ADAPTERS — CW14 owns the Athlete→Trial→Scout→Selection orchestration
// (ruling #11) and CONSUMES other lanes. These adapters isolate the cross-lane reads
// so that when CW12/CW13 freeze their exact shapes, only this file changes.
//
//   CW13 → verification badge on an athlete (is this athlete a "Verified Athlete"?)
//   CW12 → selection/match context (did a selection result come from a real match?)
//
// Until those shapes are frozen, we read the live tables defensively and degrade
// gracefully (no fabrication — absence returns null/unverified, never a guess).

import { supabaseConfigured, serviceClient } from './supabase';

export interface BadgeInfo {
  entity_type: string;
  entity_id: string;
  status: string;          // 'human_verified' is the only "blue tick" status
  verified: boolean;       // true only when status === 'human_verified'
  sig?: string | null;     // ed25519 receipt sig from CW13 (Atlas interface)
}

// CW13 seam: read sports_verifications for an athlete. Public/scout only sees
// human_verified rows (CW13's RLS). We surface the badge; we do NOT mint it.
export async function getAthleteBadge(athleteId: string): Promise<BadgeInfo | null> {
  if (!supabaseConfigured()) {
    // offline: treat as unverified unless a mock says otherwise (none do)
    return null;
  }
  try {
    const { data } = await serviceClient()
      .from('sports_verifications')
      .select('entity_type, entity_id, status, sig')
      .eq('entity_type', 'athlete')
      .eq('entity_id', athleteId)
      .order('ts', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    return {
      entity_type: data.entity_type,
      entity_id: data.entity_id,
      status: data.status,
      verified: data.status === 'human_verified',
      sig: (data as any).sig ?? null,
    };
  } catch {
    return null; // fail-closed: never claim verified on error
  }
}

// CW12 seam: selection context. CW14 records the SELECTION decision (human-gated);
// CW12 owns the match/selection *result event*. TODO(seam): replace the shape below
// with CW12's frozen selection-result event once published. For now we accept an
// optional match_id reference and store it verbatim — no interpretation.
export interface SelectionContext {
  match_id?: string | null;
  source: 'trial' | 'match' | 'manual';
}

export function normalizeSelectionContext(input: any): SelectionContext {
  return {
    match_id: input?.match_id ?? null,
    source: input?.source === 'match' || input?.source === 'manual' ? input.source : 'trial',
  };
}
