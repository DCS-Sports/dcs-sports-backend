# dcs-sports-backend — CW16 (Integration Owner · Platform Ops · Agents · Revenue)

ONE deployed backend. All lane routers (CW9–CW15) mount into the live gateway, backed by the live `dcs-sports` Supabase. **Money DARK · AI = estimate+confidence · verification human-in-loop · RLS-first · CWs build, DK deploys.**

## Integrated gateway — mounted lanes
`src/gateway/server.ts` mounts every lane (Day-0 stubs removed):
| Lane | Router | Surface |
|---|---|---|
| CW9 Identity/Rights | `routes/identity.ts` | `/me`, grants CRUD, parent-links/consent |
| CW10 Passport/Parent | `routes/athletes.ts` | RLS-filtered passport, visibility PATCH, stats, media, children |
| CW11 Academy/Coach | `routes/academy.ts` | players link, attendance, assessments, training plans, analytics |
| CW12 League (factory) | `routes/league.ts` + `routes/fixtures.ts` | leagues, fixture-gen, ball-by-ball → match_performances, standings |
| CW13 Verification | `routes/verify.ts` + `routes/atlas_sign.ts` | evidence submit, human approve (ed25519 receipt), status (RLS) |
| CW14 Scout/Trials | `routes/scout.ts` + `routes/trials_orchestration.ts` | RLS-safe search; trials (create/register/results→selection) + watchlists, persist on migration 004 |
| CW15 Vision/Talent | `routes/vision.ts` | vision job intake (model DARK), heuristic Talent (estimate), fitness tests |
| CW16 native | `gateway/server.ts` | revenue (DARK), dual-rail charge, agents+gate, **scheduled agent tick**, alerts |

## Monitoring (Platform Ops)
- `GET /health` — static liveness + mounted-lane list.
- `GET /health/ready` — fast 200/503 for Railway healthcheck; 503 if Supabase or Redis is **down**.
- `GET /health/deep` — live Supabase + Redis probes, posture, gate rollup. No secrets.
- `GET /status` — compact uptime + posture + gate rollup for the status page.
- `dcs.html` — operator console; `status.html` — public status page (both white/#0ea5e9).

## Security (see SECURITY_REVIEW.md)
Real JWT verification (`requireAuth` → `auth.getUser`), RLS-enforced reads, per-IP rate limiting (60 burst / 5-per-s, health exempt), no hardcoded secrets, money DARK. High-stakes suggestions human-gated.

## Tests — 50/50 green (`npm test`)
m_s1_e2e · revenue · alerts · gate · payments · fixtures · atlas_sign · integration · trials_orchestration · agent_tick · monitoring. Pure logic + sign/verify roundtrip + gateway-mount + health-probe degradation. DB-backed integration runs at deploy with live env.

## Acceptance gates — `npm run gates`
Honest status (no fabricated passes):
- **M-S1 GREEN (logic)** — fixtures + ball-by-ball → performance chain verified. Live DB write needs `SUPABASE_*`.
- **M-S2 GATED** — ed25519 badge signing fails closed until `SPORTS_ED25519_*` keys provisioned (no fake badges).
- **M-S3 GATED** — Vision intake live, CV model DARK (#10); **Verified Trials needs a `sports_trials` migration not in S1**.
- **M-S4 GREEN** — Talent estimate-labeled, high-stakes gate enforced, revenue splits test-mode (DARK).

## ⚠️ Schema migration awaiting CW9 apply (`migrations/004_sports_trials_watchlists.sql`)
The frozen S1 had no trials/watchlists tables. CW16 **drafted migration 004** (matching S1 style + RLS via existing helpers) adding `sports_trials`, `sports_trial_registrations`, `sports_trial_results`, `sports_watchlists`, `sports_watchlist_items`. **CW9 to review + apply.** Routes are fully wired — on apply, trials + watchlists go live; until then they return a clear "table missing — needs migration 004" error (never fabricated storage). Selection results emit a high-stakes (pending) agent suggestion + selection alert.

## Env
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=     # server-side ONLY (bypasses RLS)
SUPABASE_ANON_KEY=             # client reads through RLS (minors non-discoverable)
SPORTS_REDIS_URL=
AGENT_TICK_MS=900000           # agent tick cadence (default 15min); worker schedules it
# verification signing (CW13/DK provisions):
SPORTS_ED25519_PRIVATE_KEY=    # PEM; badge issue fails closed if unset
SPORTS_ED25519_PUBLIC_KEY=
# DARK — dual rail, both off until DK flips:
PAYMENTS_LIVE=0
# RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET (DCS Rank live+GST)
# STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET (Atlas/Agentic)
```

## Deploy (DK only)
`npm ci && npm run build && npm test && npm run gates`, then DK deploys to Railway `dcs-sports-backend`. Frontend lanes → Cloudflare Pages (white + #0ea5e9), pointed at the live gateway. CW16 never pushes prod.

## DARK / honest-scope guarantees (in code)
- One money switch `PAYMENTS_LIVE`; both rails throw on capture/confirm/payout/transfer while DARK.
- `RevenueEvent.mode` hard-typed; only `'test'` is ever produced.
- High-stakes suggestions (selection/verification/payout) write `pending`; refuse to take effect without a human actor.
- Verification badges require a real ed25519 signature — unsigned = no badge (503), never faked.
- Vision/Talent ship the S4 estimate envelope; no fabricated AI output.
