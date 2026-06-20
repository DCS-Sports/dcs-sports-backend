// CW13 — verification persistence. Routes/services call this; it targets the
// live `sports_verifications` table via the service-role client (writes bypass
// RLS, as the wire-note instructs), and falls back to the in-memory mock store
// when Supabase is unconfigured (tests).
//
// Public/anon READS of verifications already go through 003 RLS (only
// human_verified visible) — for those, callers use the anon client directly.

import { svc, anon, supabaseConfigured } from '../lib/supabase';
import { verifications } from '../mocks/store';
import type { VerificationRow } from '../lib/contracts';

const TABLE = 'sports_verifications';

export async function insertVerification(row: VerificationRow): Promise<VerificationRow> {
  if (!supabaseConfigured || !svc) {
    verifications.set(row.id, row);
    return row;
  }
  const { data, error } = await svc.from(TABLE).insert(row).select().single();
  if (error) throw new Error('DB_INSERT: ' + error.message);
  return data as VerificationRow;
}

export async function getVerification(id: string): Promise<VerificationRow> {
  if (!supabaseConfigured || !svc) {
    const row = verifications.get(id);
    if (!row) throw new Error('NOT_FOUND: verification ' + id);
    return row;
  }
  const { data, error } = await svc.from(TABLE).select('*').eq('id', id).single();
  if (error || !data) throw new Error('NOT_FOUND: verification ' + id);
  return data as VerificationRow;
}

export async function updateVerification(
  id: string,
  patch: Partial<VerificationRow>
): Promise<VerificationRow> {
  if (!supabaseConfigured || !svc) {
    const row = verifications.get(id);
    if (!row) throw new Error('NOT_FOUND: verification ' + id);
    Object.assign(row, patch);
    return row;
  }
  const { data, error } = await svc.from(TABLE).update(patch).eq('id', id).select().single();
  if (error || !data) throw new Error('DB_UPDATE: ' + (error?.message ?? 'no row'));
  return data as VerificationRow;
}

// Public badge lookup — uses the ANON client so 003 RLS applies (only
// human_verified rows are visible publicly). Returns the latest verified row
// for an entity, or null. Never exposes pending/ai_passed/rejected.
export async function getPublicBadge(
  entityType: VerificationRow['entity_type'],
  entityId: string
): Promise<VerificationRow | null> {
  if (!supabaseConfigured || !anon) {
    // mock fallback: emulate RLS by only returning human_verified
    const match = [...verifications.values()]
      .filter((r) => r.entity_type === entityType && r.entity_id === entityId && r.status === 'human_verified')
      .sort((a, b) => b.ts.localeCompare(a.ts));
    return match[0] ?? null;
  }
  const { data } = await anon
    .from(TABLE)
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('ts', { ascending: false })
    .limit(1);
  const row = (data ?? [])[0];
  return (row as VerificationRow) ?? null;
}

// All verification rows (verifier/admin — service role). Used by the reputation
// engine, which aggregates trust strictly from signed verified events.
export async function listAll(): Promise<VerificationRow[]> {
  if (!supabaseConfigured || !svc) {
    return [...verifications.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  }
  const { data, error } = await svc.from(TABLE).select('*').order('ts', { ascending: true });
  if (error) throw new Error('DB_LIST_ALL: ' + error.message);
  return (data ?? []) as VerificationRow[];
}

// All verification rows for an entity (verifier/admin — service role). Used to
// build the receipt chain + find the chain tip for prev_hash linkage.
export async function listByEntity(
  entityType: VerificationRow['entity_type'],
  entityId: string
): Promise<VerificationRow[]> {
  if (!supabaseConfigured || !svc) {
    return [...verifications.values()]
      .filter((r) => r.entity_type === entityType && r.entity_id === entityId)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }
  const { data, error } = await svc
    .from(TABLE)
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('ts', { ascending: true });
  if (error) throw new Error('DB_LIST_ENTITY: ' + error.message);
  return (data ?? []) as VerificationRow[];
}

// Admin review queue (verifier/admin only — gated by CW9 middleware upstream).
export async function listQueue(status?: VerificationRow['status']): Promise<VerificationRow[]> {
  if (!supabaseConfigured || !svc) {
    const all = [...verifications.values()];
    return status ? all.filter((r) => r.status === status) : all;
  }
  let q = svc.from(TABLE).select('*').order('ts', { ascending: true });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error('DB_LIST: ' + error.message);
  return (data ?? []) as VerificationRow[];
}
