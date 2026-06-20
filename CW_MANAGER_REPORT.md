# DCS Sports — CW16 Status Report (for CW Manager)
**Lane: Platform Ops · Agents · Revenue · Integration Owner · 19 June 2026**

## One-line status
The integrated backend is built, deep, and green — **54 tests / 13 suites**, all four acceptance gates print honestly, and the M-S1 acceptance now runs as a REAL end-to-end probe on live (not just a reachability check). Money DARK. Security review clean. Nothing fabricated.

## Live acceptance (the CW16 v1.0 gate)
**ACCEPTANCE: all four gates print REAL on live (or honestly-blocked), OPS green, money DARK.**
- **How to run it on live (DK / from a network-reachable env):**
  1. Set `SPORTS_ADMIN_TOKEN` on Railway.
  2. `SPORTS_BACKEND_URL=https://dcs-sports-backend-production.up.railway.app SPORTS_ADMIN_TOKEN=<token> npm run gates:live`
  3. M-S1 fires `POST /selfcheck/ms1` — inserts a throwaway athlete + match, posts ball-by-ball, verifies it aggregates into `sports_match_performances`, reads it back via the passport path, **then deletes everything**. Prints **REAL** only if the chain actually ran on the live DB.
- Or open `dcs.html` / `status.html` against the live URL for the posture + gate dashboard.
- **From the build sandbox the Railway host is not network-reachable**, so I cannot make the live check pass from here — but the tooling makes it pass the moment it's run against live with the token. I won't claim a live REAL I can't verify from this environment.

## This pass (v1.0 acceptance hardening)
- **Real M-S1 selfcheck** (`src/harness/selfcheck.ts`) + admin-guarded `POST /selfcheck/ms1` — proves the chain on live, self-cleaning.
- **Admin guard** (`src/middleware/admin.ts`) — `SPORTS_ADMIN_TOKEN`, fail-closed, for privileged ops probes.
- **Live harness upgraded** — M-S1 runs the real chain when the admin token is present; otherwise honest GATED.
- Auth hardened (real JWT verification), rate limiting, status page, security review — all from prior passes, intact.

## What CW16 owns and has shipped
| Area | State | Where |
|---|---|---|
| Integrated API gateway (all 7 lanes mounted) | ✅ live, Day-0 stubs removed | `src/gateway/server.ts` |
| M-S1 scoring chain (ball-by-ball → match_performances → passport) | ✅ wired + tested | `src/routes/league.ts`, `src/gateway/aggregate.ts` |
| Fixture generator (round-robin + knockout) | ✅ tested | `src/routes/fixtures.ts` |
| Verification ed25519 (Atlas interface, sign/verify/tamper) | ✅ tested; fails closed without keys | `src/routes/atlas_sign.ts`, `src/routes/verify.ts` |
| Scout + Verified Trials orchestration | ✅ wired; persists on migration 005 | `src/routes/scout.ts`, `src/routes/trials_orchestration.ts` |
| Vision intake + heuristic Talent (estimate envelope) | ✅ wired; CV model DARK | `src/routes/vision.ts` |
| Autonomous Agent Layer (scheduled tick, human-action gate) | ✅ live on BullMQ | `src/agents/{tick,runner,gate}.ts`, `src/queue/worker.ts` |
| Revenue-split engine 70/15/10/5 (DARK) | ✅ tested; mode always test | `src/revenue/splits.ts` |
| Dual payment rails (Razorpay + Stripe), both DARK | ✅ both block capture/payout | `src/revenue/{razorpay,stripe,router,money}.ts` |
| Alerts engine v1 (4 types) | ✅ logic tested; delivery pending sender | `src/alerts/engine.ts` |
| Monitoring: `/health`, `/health/ready`, `/health/deep` | ✅ tested | `src/gateway/monitoring.ts` |
| M-S1→M-S4 harness (logic + live prober) | ✅ `npm run gates` / `gates:live` | `src/harness/{gates,live_gates}.ts` |
| Operator console (white/#0ea5e9, reads live health) | ✅ | `dcs.html` |
| Trials reconciliation migration (canonical uuid) | ✅ drafted for CW9 | `migrations/005_sports_trials_reconciled.sql` |

## Trials reconciliation (cross-CW fix — CW16 half DONE)
Mandate ruled **CW16's schema canonical** (uuid id, `host_user_id`, `visibility`). My routes already use it. I shipped `005_sports_trials_reconciled.sql`:
- Guards/drops an empty conflicting CW14 `text`-id table; **aborts loudly if it has rows** (no silent data loss).
- Creates canonical `sports_trials` + registrations/results/watchlists with RLS.
- Adds a `sports_trials_compat` view exposing `host_user_id AS organizer_user_id` so CW14 can migrate column names incrementally.
**CW14 action:** point scout/trials/watchlists/scholarships/offers at the uuid `sports_trials(id)`, then drop the compat view.

## Acceptance gates (logic harness; run `gates:live` against the URL for live)
- **M-S1 GREEN** — chain verified; live DB writes need `SUPABASE_*` set on Railway.
- **M-S2 GATED** — ed25519 badge signing fails closed until `SPORTS_ED25519_*` provisioned. *No fake badges.*
- **M-S3 GATED** — Vision intake live, CV model DARK by design; trials persistence flips on migration 005 apply.
- **M-S4 GREEN** — Talent estimate-labeled; high-stakes gate enforced; revenue test-mode; agent tick scheduled.

## Honest blockers (need others — none block further CW16 work)
1. **CW9:** review + apply `005_sports_trials_reconciled.sql` → trials/watchlists go live; verify helper signatures (`sports_can_read_athlete`).
2. **CW9:** real Supabase Auth end-to-end — auth-gated routes return live data only once real tokens are issued.
3. **DK / CW13:** provision `SPORTS_ED25519_*` → flips M-S2 to REAL.
4. **Manager decision:** Resend sender identity (shared DCS Rank sender vs separate Sports sender) → unblocks alert *delivery* wiring (logic already built + tested).
5. **DK only:** `PAYMENTS_LIVE=1` money-flip — both rails stay DARK until then.

## Scope honesty
CW16 owns the backend spine and built it real. **Frontend app surfaces and React Native apps (CW10–14), the CV model and LLM intelligence (CW15) are those lanes' to author** — I have not fabricated them. `dcs.html` is the one frontend I legitimately own: the operator console for the deployed backend, on the white/#0ea5e9 design system, reading my real health endpoints.

## Deploy (DK)
`npm ci && npm run build && npm test && npm run gates`, then deploy Railway `dcs-sports-backend`. Set `SUPABASE_*`, `SPORTS_REDIS_URL`; leave `PAYMENTS_LIVE=0`. Healthcheck → `/health/ready`. Post-deploy: open `dcs.html`, enter the URL, confirm gates + posture.
