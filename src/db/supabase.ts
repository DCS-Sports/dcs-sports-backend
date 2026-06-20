// src/db/supabase.ts
// LIVE: fresh `dcs-sports` Supabase project (27 sports_* tables, RLS enforcing).
// Writes use the SERVICE ROLE (bypasses RLS, ruling). Client/anon reads go
// THROUGH RLS — visibility + parent consent + grants + minor-gating are
// DB-enforced; CW16 never hand-filters.
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _service: SupabaseClient | null = null;

/** Service-role client for server-side writes (gateway, workers).
 *  Bypasses RLS by design — agent_suggestions + revenue_events write here.
 *  Fails closed if env is unset; we never run unconfigured. */
export function getServiceClient(): SupabaseClient {
  if (_service) return _service;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      '[dcs-sports] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. ' +
        'CW16 will not run unconfigured. (Service role is server-side only — never ship to frontend.)'
    );
  }
  _service = createClient(url, key, { auth: { persistSession: false } });
  return _service;
}

/** Per-request client carrying the caller's JWT so RLS applies to THIS user.
 *  Use for any read that must respect sports_athletes visibility + grants +
 *  minor-gating. This is the DCS Rank JWT pattern. */
export function getUserScopedClient(jwt: string): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error('[dcs-sports] SUPABASE_URL / SUPABASE_ANON_KEY not set.');
  }
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
}
