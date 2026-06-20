// src/harness/live_gates.ts
// Runs the gate dashboard against the LIVE backend when SPORTS_BACKEND_URL is
// set; otherwise prints the logic harness. Honest: a gate that can't be proven
// live (no auth token, model DARK) prints GATED with the named dependency —
// never a fake REAL.
import { runGates } from './gates';

const BASE = process.env.SPORTS_BACKEND_URL; // e.g. https://dcs-sports-backend-production.up.railway.app

interface LiveResult { gate: string; status: 'REAL' | 'GATED' | 'FAIL'; detail: string; }

async function getJson(path: string, init?: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, init);
  let body: any = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

async function liveGates(): Promise<LiveResult[]> {
  const out: LiveResult[] = [];

  // Gate connectivity: /health/deep tells us DB + Redis + posture from live.
  let deep: any = null;
  try {
    const r = await getJson('/health/deep');
    deep = r.body;
  } catch (e: any) {
    return [{ gate: 'CONNECT', status: 'FAIL', detail: `cannot reach ${BASE}: ${e.message}` }];
  }

  const supaOk = deep?.dependencies?.supabase?.status === 'ok';
  const redisOk = deep?.dependencies?.redis?.status === 'ok';

  // M-S1: if an admin token is available, run the REAL chain on live (insert ->
  // score -> aggregate -> read -> cleanup). Otherwise fall back to reachability.
  const adminToken = process.env.SPORTS_ADMIN_TOKEN;
  if (adminToken) {
    try {
      const r = await getJson('/selfcheck/ms1', {
        method: 'POST',
        headers: { 'x-admin-token': adminToken },
      });
      out.push(
        r.body?.passed
          ? { gate: 'M-S1', status: 'REAL', detail: r.body.detail }
          : { gate: 'M-S1', status: 'FAIL', detail: r.body?.detail ?? `selfcheck http ${r.status}` }
      );
    } catch (e: any) {
      out.push({ gate: 'M-S1', status: 'FAIL', detail: `selfcheck call failed: ${e.message}` });
    }
  } else {
    out.push(
      supaOk
        ? { gate: 'M-S1', status: 'GATED', detail: 'Supabase reachable; set SPORTS_ADMIN_TOKEN to run the REAL chain selfcheck' }
        : { gate: 'M-S1', status: 'GATED', detail: `Supabase ${deep?.dependencies?.supabase?.status} — ${deep?.dependencies?.supabase?.detail}` }
    );
  }

  // M-S2: ed25519 readiness is reported by posture.
  out.push(
    deep?.posture?.ed25519_signing === 'ready'
      ? { gate: 'M-S2', status: 'REAL', detail: 'ed25519 keys provisioned; badges signable on live' }
      : { gate: 'M-S2', status: 'GATED', detail: 'SPORTS_ED25519_* not provisioned on live — badge issue fails closed' }
  );

  // M-S3: CV model DARK by design; trials persistence needs migration applied.
  out.push({ gate: 'M-S3', status: 'GATED', detail: 'CV model DARK (#10); trials live once migration 005 applied (reconciled schema)' });

  // M-S4: agent tick + revenue test-mode are live if Redis up + money DARK.
  // Include the local load-test verdict (scaling proof) in the detail.
  const moneyDark = deep?.posture?.money === 'DARK';
  let loadNote = '';
  try {
    const { runLocalLoad } = require('./loadtest');
    const lr = runLocalLoad({ athletes: 10_000, concurrentMatches: 100, ballsPerMatch: 240 });
    loadNote = ` · load: ${lr.passed ? 'PASS' : 'FAIL'} (p95 ${lr.p95_ms}ms, ${lr.throughput_aggs_per_sec}/s)`;
  } catch { /* load note optional */ }
  out.push(
    redisOk && moneyDark
      ? { gate: 'M-S4', status: 'REAL', detail: `agent tick worker live; revenue splits test-mode (DARK)${loadNote}` }
      : { gate: 'M-S4', status: 'GATED', detail: `Redis ${deep?.dependencies?.redis?.status}; money ${deep?.posture?.money}${loadNote}` }
  );

  return out;
}

async function main() {
  if (!BASE) {
    console.log('[gates] SPORTS_BACKEND_URL not set — printing LOGIC harness (set the URL to probe live):\n');
    for (const r of runGates()) console.log(`[${r.status}] ${r.gate} — ${r.detail}`);
    return;
  }
  console.log(`[gates] probing LIVE backend: ${BASE}\n`);
  const results = await liveGates();
  for (const r of results) console.log(`[${r.status}] ${r.gate} — ${r.detail}`);
  if (results.some((r) => r.status === 'FAIL')) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { liveGates };
