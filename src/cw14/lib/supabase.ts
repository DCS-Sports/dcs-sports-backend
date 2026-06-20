// CW14 · SUPABASE CLIENTS — the RLS-safety split is the whole point.
//
//  serviceClient()  -> SERVICE_ROLE key. BYPASSES RLS. Writes ONLY (inserts/updates
//                      CW14 owns: watchlists, reports, trials, registrations).
//                      NEVER use this to read athlete rows for a scout — it would
//                      leak private/minor rows past the policy.
//
//  userClient(jwt)  -> ANON key + the caller's JWT. Reads go THROUGH RLS. This is
//                      how every scout/search/compare read runs — Postgres enforces
//                      visibility + parent consent + grants + minor-gating. CW14
//                      does NOT hand-filter; the DB returns only allowed rows.
//
// If env is absent (offline test), callers fall back to the mock layer.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;

export const supabaseConfigured = (): boolean => !!(URL && (SERVICE || ANON));

let _service: SupabaseClient | null = null;
export function serviceClient(): SupabaseClient {
  if (!URL || !SERVICE) throw new Error('SUPABASE_URL / SERVICE_ROLE_KEY missing — writes unavailable');
  if (!_service) _service = createClient(URL, SERVICE, { auth: { persistSession: false } });
  return _service;
}

// Per-request: the caller's JWT scopes the read so RLS applies. Never cached across users.
export function userClient(jwt: string | undefined): SupabaseClient {
  if (!URL || !ANON) throw new Error('SUPABASE_URL / ANON_KEY missing — scoped reads unavailable');
  return createClient(URL, ANON, {
    auth: { persistSession: false },
    global: { headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} },
  });
}
