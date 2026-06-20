# DCS Sports — CW16 Security Review
**19 June 2026 · backend (`dcs-sports-backend`) · scope: authz, minor-data, secrets, abuse**

## Summary
No critical findings. The backend enforces authorization at the database (RLS), verifies real JWTs at the edge, keeps all money DARK, and holds no hardcoded secrets. Hardening added this pass: real token verification + per-IP rate limiting.

## 1. Authorization (authz)
- **JWT verification (hardened):** `requireAuth` now calls `supabase.auth.getUser(jwt)` — invalid/expired tokens get a clean **401** instead of leaking to a downstream error. A verified `userId` is attached for handlers. `optionalAuth` added for public/private tiered reads.
- **RLS is the authority:** every athlete read uses the user-scoped client (`rls()`), so the DB decides visibility (private/academy/discoverable/public) + minor-gating. Handlers never hand-filter rows.
- **Audit (clean):** the only service-role (RLS-bypassing) athlete touch is a `visibility` UPDATE, and it is preceded by an ownership check through the RLS client. Other `svc()` reads are non-athlete (fixtures, vision job status).

## 2. Minor-data protection
- Minors (`dob` < 18) are **non-discoverable by default** at RLS — scout/search/public reads are blocked unless a valid `sports_data_access_grants` row exists AND (per mandate) DK+counsel clear the discoverable flip.
- Scout search (`/scout/search`) runs through the RLS-scoped client — it **cannot enumerate minors** it isn't granted. Verified by design; CW9 owns the RLS policy proof + tests.
- Recommendation: keep Supabase "Confirm email" **ON** before any public/minor onboarding (per the auth one-pager).

## 3. Secrets
- **No hardcoded secrets** — scan clean; every credential read is `process.env.*`.
- Service-role key is server-side only (Railway env); never returned by any endpoint, including `/health/deep` (posture booleans only, no values).
- ed25519 private key read from env; signing **fails closed** if unset (no fake badges).

## 4. Money (DARK)
- One switch: `PAYMENTS_LIVE` (`money.ts`). Both rails (Razorpay, Stripe) throw on capture/confirm/payout/transfer while DARK. `RevenueEvent.mode` is hard-typed and only ever `'test'`.

## 5. Abuse / availability (hardened)
- **Rate limiting added:** per-IP token bucket (60 burst, 5/s sustained) on all routes except `/health*` (monitoring must stay reachable). Returns 429 + `Retry-After`.
- Note: in-memory store is per-instance; move to a Redis-backed store before scaling past one instance.

## 5b. Admin ops (added)
- Privileged probes (`POST /selfcheck/ms1`) sit behind `requireAdmin` (`x-admin-token` === `SPORTS_ADMIN_TOKEN`), **fail-closed** (503) if the token is unset — never open. The selfcheck uses a `selfcheck_` tag + deletes its own rows.

## 6. High-stakes gate
- Selections/verifications/payouts write `pending` and **cannot take effect without a human actor** (`agents/gate.ts`). Autonomous agents propose; humans dispose.

## Open (owned by others)
- Real Supabase Auth providers must be enabled (CW9 / DK per the one-pager) for end-to-end login.
- Migration 005 (reconciled trials) apply (CW9).
- `SPORTS_ED25519_*` provisioning (DK/CW13) to make verification badges issue.
