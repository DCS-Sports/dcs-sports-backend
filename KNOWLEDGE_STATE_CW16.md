# DCS SPORTS — CW16 KNOWLEDGE STATE
**Updated 19 June 2026 · Lane: Platform Ops · Agents · Revenue · Integration Owner**

## Live foundation
- Backend gateway: `https://dcs-sports-backend-production.up.railway.app` (all 7 lanes mounted)
- Supabase (Sports): `llhyntwsgtimfpedukro` — core schema applied, RLS enforcing
- Design system: white + light-blue `#0ea5e9`
- Rules: money DARK (`PAYMENTS_LIVE=0`, Razorpay+Stripe) · AI = estimate+confidence, model DARK · verification human-in-loop, ed25519 · RLS-first, minors non-discoverable · DK deploys

## Repo: dcs-sports-backend (npm-ci-runnable, 54 tests / 13 suites green)
```
src/
  gateway/      server.ts (integrated mounts) · aggregate.ts (M-S1) · monitoring.ts (health/deep)
  routes/       identity athletes academy league fixtures verify scout vision
                atlas_sign (ed25519) trials_orchestration _helpers
  agents/       gate.ts (human-action gate) · tick.ts (scan logic) · runner.ts (live load+persist)
  revenue/      splits.ts (70/15/10/5) · money.ts (PAYMENTS_LIVE guard) · razorpay.ts · stripe.ts · router.ts
  alerts/       engine.ts (4 alert types)
  queue/        index.ts (BullMQ conn) · worker.ts (scheduled agent tick + alert + vision lanes)
  harness/      gates.ts (logic) · live_gates.ts (probes deployed URL)
  db/           supabase.ts (service-role writes + RLS-scoped reads)
  types.ts      S4 estimate envelope (frozen)
migrations/     004_sports_trials_watchlists.sql · 005_sports_trials_reconciled.sql (canonical)
tests/          11 suites, 48 tests
dcs.html        operator console (live health/gate dashboard)
railway.ci.yaml · README.md · CW_MANAGER_REPORT.md
```

## Acceptance gates
- M-S1 GREEN (logic) — live DB write needs SUPABASE_* env
- M-S2 GATED — ed25519 keys (SPORTS_ED25519_*) not provisioned; fails closed
- M-S3 GATED — CV model DARK by design; trials persist on migration 005 apply
- M-S4 GREEN — talent estimate, high-stakes gate, revenue test-mode, scheduled agents

## Env (Railway)
```
SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · SUPABASE_ANON_KEY · SPORTS_REDIS_URL
AGENT_TICK_MS=900000
PAYMENTS_LIVE=0   (DK-only flip)
SPORTS_ED25519_PRIVATE_KEY · SPORTS_ED25519_PUBLIC_KEY   (badge signing; fail-closed if unset)
RAZORPAY_KEY_ID · RAZORPAY_KEY_SECRET · STRIPE_SECRET_KEY · STRIPE_WEBHOOK_SECRET   (DARK)
SPORTS_BACKEND_URL   (for npm run gates:live)
SPORTS_ADMIN_TOKEN   (enables POST /selfcheck/ms1; fail-closed)
```

## Open items (need others)
1. CW9 — apply migration 005 (trials reconciliation, canonical uuid) + real Supabase Auth
2. DK/CW13 — provision SPORTS_ED25519_* → M-S2 REAL
3. Manager — Resend sender identity → alert delivery wiring
4. DK — PAYMENTS_LIVE=1 money-flip

## Honest scope note
CW16 owns the backend spine (built real). Frontend/mobile (CW10–14) and CV/LLM (CW15) are those lanes'. dcs.html is the operator console — the one frontend CW16 legitimately owns.

## Commands
`npm ci · npm run build · npm test · npm run gates · npm run gates:live · npm start · npm run worker`
