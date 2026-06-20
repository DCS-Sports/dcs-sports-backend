// src/harness/audit.ts
// Runnable security + minor-data audit (v3.0 acceptance: 0 criticals).
// Static + behavioral checks over the codebase posture. Each check is
// CRITICAL | WARN | OK. Acceptance passes only if zero CRITICAL.
import { isHighStakes } from '../agents/gate';
import { reconcile } from '../revenue/reconcile';
import { paymentsLive } from '../revenue/money';
import * as fs from 'fs';
import * as path from 'path';

type Severity = 'CRITICAL' | 'WARN' | 'OK';
interface Finding { area: string; severity: Severity; detail: string; }

const SRC = path.join(__dirname, '..');

function readAll(dir: string): string {
  let out = '';
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) out += readAll(p);
    else if (f.endsWith('.ts')) out += fs.readFileSync(p, 'utf8');
  }
  return out;
}

export function runAudit(): { findings: Finding[]; criticals: number; passed: boolean } {
  const findings: Finding[] = [];
  const code = readAll(SRC);

  // 1. Secrets: no hardcoded credentials (everything via process.env).
  const hardcoded = /(secret|password|apikey|api_key)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i.test(
    code.replace(/process\.env\.[A-Z_]+/g, '')
  );
  findings.push(hardcoded
    ? { area: 'secrets', severity: 'CRITICAL', detail: 'possible hardcoded secret' }
    : { area: 'secrets', severity: 'OK', detail: 'no hardcoded secrets; all credentials via process.env' });

  // 2. Minor-data: scout/search reads must use the RLS-scoped client, not svc().
  const scout = fs.existsSync(path.join(SRC, 'routes/scout.ts'))
    ? fs.readFileSync(path.join(SRC, 'routes/scout.ts'), 'utf8') : '';
  const scoutUsesRls = /rls\(req\)/.test(scout) && !/svc\(\)\.from\('sports_athletes'\)\.select/.test(scout);
  findings.push(scoutUsesRls
    ? { area: 'minor-data', severity: 'OK', detail: 'scout search reads through RLS; minors non-discoverable at DB' }
    : { area: 'minor-data', severity: 'CRITICAL', detail: 'scout search may bypass RLS — minor leak risk' });

  // 3. Athlete reads must not use service-role select (RLS bypass).
  const athletes = fs.existsSync(path.join(SRC, 'routes/athletes.ts'))
    ? fs.readFileSync(path.join(SRC, 'routes/athletes.ts'), 'utf8') : '';
  const badAthleteRead = /svc\(\)\.from\('sports_athletes'\)\.select/.test(athletes);
  findings.push(badAthleteRead
    ? { area: 'authz', severity: 'CRITICAL', detail: 'athlete READ via service role (RLS bypass)' }
    : { area: 'authz', severity: 'OK', detail: 'athlete reads use RLS-scoped client' });

  // 4. Auth: requireAuth verifies the token (getUser), not just attaches it.
  const auth = fs.existsSync(path.join(SRC, 'middleware/auth.ts'))
    ? fs.readFileSync(path.join(SRC, 'middleware/auth.ts'), 'utf8') : '';
  findings.push(/auth\.getUser\(/.test(auth)
    ? { area: 'authz', severity: 'OK', detail: 'requireAuth verifies real JWT via auth.getUser' }
    : { area: 'authz', severity: 'CRITICAL', detail: 'JWT not verified at edge' });

  // 5. Admin ops fail closed.
  const admin = fs.existsSync(path.join(SRC, 'middleware/admin.ts'))
    ? fs.readFileSync(path.join(SRC, 'middleware/admin.ts'), 'utf8') : '';
  findings.push(/SPORTS_ADMIN_TOKEN/.test(admin) && /503/.test(admin)
    ? { area: 'authz', severity: 'OK', detail: 'admin ops fail closed when token unset' }
    : { area: 'authz', severity: 'WARN', detail: 'admin guard posture unclear' });

  // 6. Money DARK + reconciliation balances (behavioral).
  const rc = reconcile([
    { id: 'e1', source: 'subscription', athlete_id: 'a1', academy_id: 'ac1', agent_id: 'ag1', gross_paise: 99900 },
    { id: 'e2', source: 'trial_fee', athlete_id: 'a2', gross_paise: 50001 },
  ]);
  findings.push(rc.balanced && !paymentsLive
    ? { area: 'money', severity: 'OK', detail: `reconcile balances (leakage ${rc.leakage_paise}); PAYMENTS_LIVE off` }
    : { area: 'money', severity: 'CRITICAL', detail: `money posture: balanced=${rc.balanced}, paymentsLive=${paymentsLive}` });

  // 7. High-stakes gate enforced for selections/verifications/payouts.
  const gateOk = isHighStakes({ subject_type: 'selection' }) && isHighStakes({ subject_type: 'payout' });
  findings.push(gateOk
    ? { area: 'authz', severity: 'OK', detail: 'high-stakes actions require human action' }
    : { area: 'authz', severity: 'CRITICAL', detail: 'high-stakes gate not enforced' });

  const criticals = findings.filter((f) => f.severity === 'CRITICAL').length;
  return { findings, criticals, passed: criticals === 0 };
}

if (require.main === module) {
  const { findings, criticals, passed } = runAudit();
  for (const f of findings) console.log(`[${f.severity}] ${f.area} — ${f.detail}`);
  console.log(`\n${passed ? 'PASS' : 'FAIL'} — ${criticals} critical finding(s)`);
  process.exit(passed ? 0 : 1);
}
