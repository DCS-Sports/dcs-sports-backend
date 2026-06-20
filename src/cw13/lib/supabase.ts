// CW13 — Supabase clients for the live `dcs-sports` project.
// Service role (server-side ONLY) bypasses RLS for our verification writes.
// Anon client goes THROUGH RLS — used for public/anon reads (003 RLS already
// exposes only human_verified verifications; minors non-discoverable).
//
// When env is absent (e.g. `npm test`), both are null and the repo layer falls
// back to the in-memory mock store — so the suite runs with no network/creds.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

export const svc: SupabaseClient | null =
  url && serviceKey
    ? createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

export const anon: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

// A per-request anon client carrying the caller's JWT, so RLS evaluates against
// the real user (sports_auth_uid()). Used for client reads that must pass RLS.
export function anonAs(jwt: string): SupabaseClient | null {
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

export const supabaseConfigured = svc !== null;
