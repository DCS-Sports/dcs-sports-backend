import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Two access paths, per the SCHEMA-LIVE wire note (19 Jun):
 *  - WRITES use SUPABASE_SERVICE_ROLE_KEY (server-side only). Service role
 *    BYPASSES RLS so inserts/updates always work. NEVER ship this key to the
 *    frontend.
 *  - READS for a specific caller go through RLS using that caller's JWT, so the
 *    DB enforces visibility + parent consent + grants + minor-gating. We never
 *    hand-filter; we trust the policies.
 *
 * If env is absent (e.g. Day-0 / CI without secrets), callers fall back to the
 * mock layer — see routes. This module never throws at import time.
 */

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

export const supabaseEnabled = Boolean(URL && SERVICE_KEY);

let _service: SupabaseClient | null = null;

/** Service-role client for WRITES (bypasses RLS). Server-side only. */
export function serviceClient(): SupabaseClient {
  if (!URL || !SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  if (!_service) {
    _service = createClient(URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _service;
}

/**
 * RLS-scoped client for READS as a specific caller. Pass the caller's JWT
 * (CW9-issued). The anon key + the Authorization header means every query runs
 * under that user's RLS context — a scout token will NOT see a private/minor row.
 */
export function rlsClient(accessToken: string): SupabaseClient {
  if (!URL || !ANON_KEY) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set');
  return createClient(URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
