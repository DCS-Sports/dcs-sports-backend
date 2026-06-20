// CW12 — Supabase client.
// Server-side writes use SUPABASE_SERVICE_ROLE_KEY (bypasses RLS — our inserts keep working).
// NEVER ship the service key to a frontend. Client/anon reads go through RLS via SUPABASE_ANON_KEY.
//
// Lazy + null-safe: when env is unset (tests, pre-provision), getSupabase() returns null and
// the data layer falls back to the in-memory store — same interface, no route changes.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _service: SupabaseClient | null | undefined;

export function getSupabase(): SupabaseClient | null {
  if (_service !== undefined) return _service;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    _service = null;
    return _service;
  }
  _service = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _service;
}

/** True when the lane is wired to a real Supabase project. */
export function isSupabaseLive(): boolean {
  return getSupabase() !== null;
}
