// src/gateway/monitoring.ts
// Deep health for Platform Ops. Probes live dependencies + reports posture so
// DK can confirm the deployed backend is wired correctly. Never throws — each
// probe degrades to an honest status. No secrets are ever returned.
import { getServiceClient } from '../db/supabase';
import { getConnection } from '../queue';
import { runGates } from '../harness/gates';

export type ProbeStatus = 'ok' | 'down' | 'unconfigured';

export interface DeepHealth {
  service: string;
  lane: string;
  checked_at: string;
  dependencies: {
    supabase: { status: ProbeStatus; detail: string };
    redis: { status: ProbeStatus; detail: string };
  };
  posture: {
    money: 'DARK' | 'LIVE';
    payments_live: boolean;
    ed25519_signing: 'ready' | 'unconfigured';
    agent_tick_ms: number;
  };
  gates: Array<{ gate: string; status: string }>;
  healthy: boolean; // true if no dependency is 'down'
}

async function probeSupabase(): Promise<{ status: ProbeStatus; detail: string }> {
  try {
    const sb = getServiceClient(); // throws if env unset
    // cheap, RLS-bypassing count against a known table
    const { error } = await sb.from('sports_users').select('id', { count: 'exact', head: true });
    if (error) return { status: 'down', detail: error.message };
    return { status: 'ok', detail: 'sports_users reachable' };
  } catch (e: any) {
    if (/not set|unconfigured/i.test(e.message)) return { status: 'unconfigured', detail: 'SUPABASE_* env not set' };
    return { status: 'down', detail: e.message };
  }
}

async function probeRedis(): Promise<{ status: ProbeStatus; detail: string }> {
  // Lazy-require ioredis (bundled via bullmq) so a missing dep never crashes.
  try {
    const opts: any = getConnection(); // throws if SPORTS_REDIS_URL unset
    const IORedis = require('bullmq/node_modules/ioredis');
    const client = new IORedis({ ...opts, lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await client.connect();
      const pong = await client.ping();
      await client.quit();
      return { status: pong === 'PONG' ? 'ok' : 'down', detail: `ping=${pong}` };
    } catch (e: any) {
      try { client.disconnect(); } catch {}
      return { status: 'down', detail: e.message };
    }
  } catch (e: any) {
    if (/not set|unconfigured/i.test(e.message)) return { status: 'unconfigured', detail: 'SPORTS_REDIS_URL not set' };
    return { status: 'down', detail: e.message };
  }
}

export async function deepHealth(): Promise<DeepHealth> {
  const [supabase, redis] = await Promise.all([probeSupabase(), probeRedis()]);
  const gates = runGates().map((g) => ({ gate: g.gate, status: g.status }));
  const healthy = supabase.status !== 'down' && redis.status !== 'down';
  return {
    service: 'dcs-sports-backend',
    lane: 'CW16 (integration owner)',
    checked_at: new Date().toISOString(),
    dependencies: { supabase, redis },
    posture: {
      money: process.env.PAYMENTS_LIVE === '1' ? 'LIVE' : 'DARK',
      payments_live: process.env.PAYMENTS_LIVE === '1',
      ed25519_signing:
        process.env.SPORTS_ED25519_PRIVATE_KEY && process.env.SPORTS_ED25519_PUBLIC_KEY ? 'ready' : 'unconfigured',
      agent_tick_ms: Number(process.env.AGENT_TICK_MS ?? 15 * 60 * 1000),
    },
    gates,
    healthy,
  };
}
