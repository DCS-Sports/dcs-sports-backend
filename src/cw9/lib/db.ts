// src/lib/db.ts
// CW9 data layer. Two access modes, per the SCHEMA_LIVE wire-note:
//   1) service role  -> bypasses RLS, for server-side writes/admin (SUPABASE_SERVICE_ROLE_KEY)
//   2) session read   -> goes THROUGH RLS via a pg connection that sets
//                        request.jwt.claim.sub = <uid> in the same transaction.
// If Supabase env is absent we fall back to the in-memory mock so npm test runs
// offline and consumers still get contract-valid behaviour. The DB is the
// source of truth in production; the mock is a faithful shadow.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PG_URL = process.env.SUPABASE_DB_URL; // direct pg conn for RLS-session reads

export const LIVE = Boolean(URL && SERVICE_KEY);

/** service-role client — bypasses RLS. Server-side ONLY. */
export const service: SupabaseClient | null =
  LIVE ? createClient(URL!, SERVICE_KEY!, { auth: { persistSession: false } }) : null;

/** A read that must pass S3 RLS as a specific user. Opens a tx, pins the claim,
 *  runs the query, rolls back (read-only). Returns rows the policies allow. */
let pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!pool) {
    if (!PG_URL) throw new Error("SUPABASE_DB_URL not set — needed for RLS-session reads");
    pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
  }
  return pool;
}

export async function rlsRead<T = any>(
  uid: string | null,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    // run as the non-superuser app/authenticated role so RLS engages
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [uid ?? ""]);
    const r = await client.query(sql, params);
    await client.query("commit");
    return r.rows as T[];
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function closeDb() {
  if (pool) await pool.end();
}
