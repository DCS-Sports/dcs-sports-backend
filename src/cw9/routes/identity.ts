// src/routes/identity.ts
// CW9 S2 surface (frozen shapes). Backed by repo.ts → real Supabase when env is
// present, in-memory mock otherwise. Same shapes either way.

import { Router } from "express";
import type { Request, Response } from "express";
import { repo, FROZEN_ROLES, type Role } from "../lib/repo";

export const identityRouter = Router();

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) => { fn(req, res).catch(e => res.status(500).json({ error: String(e?.message ?? e) })); };

// Roles a user may NEVER self-assign at signup (staff-only, granted by an admin).
const PRIVILEGED_ROLES = ["admin", "verifier"] as const;

// ---- AUTH (real Supabase Auth when SUPABASE_* env present; mock offline) ----
identityRouter.post("/auth/signup", wrap(async (req, res) => {
  const { email, password, name, dob, role_flags } = req.body ?? {};
  if (!email || !name) return res.status(400).json({ error: "email and name required" });
  if (repo.live && !password) return res.status(400).json({ error: "password required" });
  const flags: Role[] = Array.isArray(role_flags) && role_flags.length ? role_flags : ["athlete"];
  const bad = flags.find(f => !FROZEN_ROLES.includes(f));
  if (bad) return res.status(400).json({ error: `invalid role: ${bad}`, allowed: FROZEN_ROLES });
  // SECURITY: privileged roles can never be acquired via self-signup.
  const escalation = flags.find(f => (PRIVILEGED_ROLES as readonly string[]).includes(f));
  if (escalation) return res.status(403).json({ error: `role '${escalation}' cannot be self-assigned; it is granted by an admin` });
  const out = await repo.signupEmail(email, password ?? "mock", name, flags, dob);
  if ((out as any).error) return res.status(400).json({ error: (out as any).error });
  res.status(201).json(out);
}));

identityRouter.post("/auth/login", wrap(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email) return res.status(400).json({ error: "email required" });
  const out = await repo.loginEmail(email, password ?? "mock");
  if ((out as any).error) return res.status(401).json({ error: (out as any).error });
  res.json(out);
}));

// Google OAuth: client GETs this, opens the returned url; Supabase redirects back with a session.
identityRouter.get("/auth/google", wrap(async (req, res) => {
  const redirectTo = String(req.query.redirect_to || "");
  if (!redirectTo) return res.status(400).json({ error: "redirect_to required" });
  const out = await repo.googleAuthUrl(redirectTo);
  if ((out as any).error) return res.status(400).json({ error: (out as any).error });
  res.json(out);
}));

// Password reset: request a recovery email (never leaks whether the email exists).
identityRouter.post("/auth/reset-request", wrap(async (req, res) => {
  const { email, redirect_to } = req.body ?? {};
  if (!email) return res.status(400).json({ error: "email required" });
  await repo.requestPasswordReset(email, redirect_to || "");
  res.json({ ok: true, message: "if that email exists, a reset link has been sent" });
}));

// Password reset: set a new password using the recovery token from the email link.
identityRouter.post("/auth/reset-update", wrap(async (req, res) => {
  const { recovery_token, new_password } = req.body ?? {};
  if (!recovery_token || !new_password) return res.status(400).json({ error: "recovery_token + new_password required" });
  if (String(new_password).length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
  const out = await repo.updatePassword(recovery_token, new_password);
  if (!out.ok) return res.status(400).json({ error: out.error });
  res.json({ ok: true });
}));

// ---- GET /me ----
identityRouter.get("/me", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const me = await repo.getMe(uid);
  if (!me) return res.status(401).json({ error: "unauthenticated" });
  res.json({ id: me.id, name: me.name, email: me.email, dob: me.dob, role_flags: me.role_flags });
}));

// ---- PROFILE · BUILDER · PUBLISH · SUBSCRIPTION (DARK) ----
identityRouter.get("/me/profile", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  res.json({ profile: await repo.getProfile(uid) });
}));

identityRouter.patch("/me/profile", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const { display_name, avatar_url, bio, site_slug, site_json } = req.body ?? {};
  const out = await repo.upsertProfile(uid, { display_name, avatar_url, bio, site_slug, site_json });
  if ((out as any)?.error) return res.status(400).json({ error: (out as any).error });
  res.json({ profile: out });
}));

identityRouter.post("/me/publish", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const publish = req.body?.published !== false;
  const out = await repo.publishProfile(uid, publish);
  if ((out as any)?.error) return res.status(409).json({ error: (out as any).error });
  res.json({ profile: out });
}));

identityRouter.post("/me/subscription", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const { tier, status } = req.body ?? {};
  const tiers = ["free", "pro", "academy"]; const statuses = ["inactive", "trialing", "active", "past_due"];
  if (!tiers.includes(tier) || !statuses.includes(status)) return res.status(400).json({ error: "invalid tier/status" });
  const out = await repo.setSubscription(uid, tier, status);
  res.json({ profile: out, money: "DARK" });
}));

// ---- RLS-respecting athlete read (client reads go THROUGH RLS) ----
identityRouter.get("/athletes/visible", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  res.json({ athletes: await repo.athletesVisibleTo(uid) });
}));

// Read one athlete (RLS-filtered) + log it if a third party reads a minor.
identityRouter.get("/athletes/:id", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  const list = await repo.athletesVisibleTo(uid);
  const a = (list as any[]).find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "not found or not visible" });
  // best-effort minor-access audit (only fires for third-party reads of a minor)
  await repo.logMinorAccess(req.params.id, uid, "profile", "athlete_read");
  res.json({ athlete: a });
}));

// Rights-holder views WHO accessed their minor's data (mandate item 6).
identityRouter.get("/athletes/:id/access-log", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.canApproveFor(req.params.id, uid)) && !(await repo.ownsAthlete(req.params.id, uid)))
    return res.status(403).json({ error: "forbidden" });
  res.json({ access_log: await repo.minorAccessLog(req.params.id) });
}));

// ---- GRANTS CRUD ----
identityRouter.get("/athletes/:id/grants", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.ownsAthlete(req.params.id, uid)) && !(await repo.isStaff(uid)))
    return res.status(403).json({ error: "forbidden" });
  res.json({ grants: await repo.listGrants(req.params.id) });
}));

identityRouter.post("/athletes/:id/grants", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.ownsAthlete(req.params.id, uid)))
    return res.status(403).json({ error: "only the athlete (or guardian via consent) may grant access" });
  const { grantee_id, scope, expires_at, ttl_days } = req.body ?? {};
  const scopes = ["profile", "stats", "media", "video", "sponsor", "full"];
  if (!grantee_id || !scopes.includes(scope))
    return res.status(400).json({ error: "grantee_id + scope(profile|stats|media|video|sponsor|full) required" });
  const exp = expires_at ?? (ttl_days ? new Date(Date.now() + Number(ttl_days) * 86400000).toISOString() : null);
  res.status(201).json({ grant: await repo.addGrant(req.params.id, grantee_id, scope, exp) });
}));

identityRouter.delete("/grants/:grantId", wrap(async (req, res) => {
  const g = await repo.grantById(req.params.grantId);
  if (!g) return res.status(404).json({ error: "not found" });
  const uid = req.session?.sub ?? null;
  if (!(await repo.ownsAthlete(g.athlete_id, uid))) return res.status(403).json({ error: "forbidden" });
  await repo.revokeGrant(req.params.grantId);
  res.json({ revoked: true, id: req.params.grantId });
}));

// ---- grant renewal: extend expiry (preserves the grant + its audit chain) ----
identityRouter.post("/grants/:grantId/renew", wrap(async (req, res) => {
  const g = await repo.grantById(req.params.grantId);
  if (!g) return res.status(404).json({ error: "not found" });
  const uid = req.session?.sub ?? null;
  if (!(await repo.canApproveFor(g.athlete_id, uid)))
    return res.status(403).json({ error: "only the rights-holder (adult athlete / consented parent / staff) may renew" });
  const { expires_at, ttl_days } = req.body ?? {};
  const exp = expires_at ?? (ttl_days ? new Date(Date.now() + Number(ttl_days) * 86400000).toISOString() : null);
  const out = await repo.renewGrant(req.params.grantId, exp);
  res.json({ grant: out });
}));

// ---- bulk console: all active grants across athletes this user controls ----
identityRouter.get("/me/granted-access", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  res.json({ grants: await repo.activeGrantsControlledBy(uid) });
}));

// ---- bulk revoke: revoke many grants the user controls in one call ----
identityRouter.post("/me/grants/bulk-revoke", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const ids: string[] = Array.isArray(req.body?.grant_ids) ? req.body.grant_ids : [];
  if (!ids.length) return res.status(400).json({ error: "grant_ids[] required" });
  const controlled = new Set(await repo.athletesControlledBy(uid));
  const results: { id: string; revoked: boolean }[] = [];
  for (const id of ids) {
    const g = await repo.grantById(id);
    if (g && controlled.has(g.athlete_id)) { await repo.revokeGrant(id); results.push({ id, revoked: true }); }
    else results.push({ id, revoked: false });
  }
  res.json({ results, revoked: results.filter(r => r.revoked).length });
}));

// ---- expiring-soon: grants nearing expiry for the controller to renew/let lapse ----
identityRouter.get("/me/grants/expiring", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const days = Math.min(Math.max(Number(req.query.days ?? 7), 1), 90);
  const grants = await repo.grantsExpiringSoon(uid, days);
  res.json({ within_days: days, count: grants.length, grants });
}));

// ---- PARENT CONSENT ----
identityRouter.post("/parent-links/:athleteId/consent", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const link = await repo.setConsent(req.params.athleteId, uid, req.body?.consent !== false);
  if (!link) return res.status(404).json({ error: "no parent link for this user/athlete" });
  res.json({ link });
}));

// ---- ADMIN OVERVIEW (staff only) ----
identityRouter.get("/admin/overview", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.isStaff(uid))) return res.status(403).json({ error: "staff only" });
  res.json(await repo.adminOverview());
}));

// ====================================================================
// R2 — ATHLETE RIGHTS CHARTER (write side): access-request lifecycle
// ====================================================================

// A logged-in user (e.g. a scout) requests access to an athlete's data.
identityRouter.post("/athletes/:id/access-requests", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const { scope, reason } = req.body ?? {};
  const scopes = ["profile", "stats", "media", "video", "sponsor", "full"];
  if (!scopes.includes(scope)) return res.status(400).json({ error: "scope must be profile|stats|media|video|sponsor|full" });
  const out = await repo.createRequest(req.params.id, uid, scope, reason);
  if ((out as any)?.error) return res.status(409).json({ error: (out as any).error });
  res.status(201).json({ request: out });
}));

// The rights-holder (adult athlete / consented parent / staff) lists requests.
identityRouter.get("/athletes/:id/access-requests", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.canApproveFor(req.params.id, uid)) && !(await repo.ownsAthlete(req.params.id, uid)))
    return res.status(403).json({ error: "forbidden" });
  res.json({ requests: await repo.listRequestsForAthlete(req.params.id) });
}));

// Approve / deny — co-consent enforced: a minor's request needs a consented parent.
identityRouter.post("/access-requests/:reqId/decide", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const decision = req.body?.decision;
  if (!["approved", "denied"].includes(decision)) return res.status(400).json({ error: "decision must be approved|denied" });
  const { expires_at, ttl_days } = req.body ?? {};
  const exp = expires_at ?? (ttl_days ? new Date(Date.now() + Number(ttl_days) * 86400000).toISOString() : null);
  const out = await repo.decideRequest(req.params.reqId, uid, decision, exp);
  if (!out.ok) return res.status(403).json({ error: out.reason });
  res.json(out);
}));

// ====================================================================
// ORG / FEDERATION ACCOUNTS + ROLE DELEGATION (v2.0)
// ====================================================================
// Create an org (caller becomes org_admin).
identityRouter.post("/orgs", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const { kind, name, parent_org } = req.body ?? {};
  const kinds = ["federation", "association", "academy", "club"];
  if (!kinds.includes(kind) || !name) return res.status(400).json({ error: "valid kind + name required" });
  const out = await repo.createOrg(kind, name, uid, parent_org);
  if ((out as any)?.error) return res.status(400).json({ error: (out as any).error });
  res.status(201).json({ org: out });
}));

// List members of an org (members + staff only — RLS also enforces).
identityRouter.get("/orgs/:orgId/members", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.isOrgAdmin(req.params.orgId, uid)) && !(await repo.isStaff(uid)))
    return res.status(403).json({ error: "org admin only" });
  res.json({ members: await repo.listOrgMembers(req.params.orgId) });
}));

// Delegate an org-scoped role (never grants global staff power).
identityRouter.post("/orgs/:orgId/delegate", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  const { user_id, org_role } = req.body ?? {};
  if (!user_id || !org_role) return res.status(400).json({ error: "user_id + org_role required" });
  const out = await repo.delegateOrgRole(req.params.orgId, uid, user_id, org_role);
  if (!out.ok) return res.status(out.reason === "org admin only" ? 403 : 400).json({ error: out.reason });
  res.json(out);
}));

// Revoke an org-scoped role.
identityRouter.post("/orgs/:orgId/revoke-role", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  const { user_id, org_role } = req.body ?? {};
  if (!user_id || !org_role) return res.status(400).json({ error: "user_id + org_role required" });
  const out = await repo.revokeOrgRole(req.params.orgId, uid, user_id, org_role);
  if (!out.ok) return res.status(out.reason === "org admin only" ? 403 : 400).json({ error: out.reason });
  res.json(out);
}));

// Delegation audit (who granted/revoked what in this org).
identityRouter.get("/orgs/:orgId/delegation-audit", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.isOrgAdmin(req.params.orgId, uid)) && !(await repo.isStaff(uid)))
    return res.status(403).json({ error: "org admin only" });
  res.json({ audit: await repo.orgDelegationAudit(req.params.orgId) });
}));

// ====================================================================
// ATHLETE DATA OWNERSHIP FRAMEWORK + PAYOUT-KYC SHELL (v3.0)
// ====================================================================
// Establish the athlete as owner of their data (rights-holder/parent/staff).
identityRouter.post("/athletes/:id/ownership", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.canApproveFor(req.params.id, uid)) && !(await repo.ownsAthlete(req.params.id, uid)))
    return res.status(403).json({ error: "forbidden" });
  const owner = await repo.athleteOwnerUser(req.params.id);
  const out = await repo.establishOwnership(req.params.id, owner ?? (uid as string), uid);
  if ((out as any)?.error) return res.status(400).json({ error: (out as any).error });
  res.status(201).json({ ownership: out });
}));

// Portable ownership manifest — proves the athlete owns + can take their data.
identityRouter.get("/athletes/:id/ownership-manifest", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.canApproveFor(req.params.id, uid)) && !(await repo.ownsAthlete(req.params.id, uid)))
    return res.status(403).json({ error: "forbidden" });
  res.json(await repo.ownershipManifest(req.params.id));
}));

// Payout-KYC shell — DARK. Records intent; never moves money.
identityRouter.get("/me/kyc", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  res.json({ kyc: await repo.getKyc(uid), payout: "DARK" });
}));

identityRouter.post("/me/kyc", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const { legal_name, kyc_ref } = req.body ?? {};
  if (!legal_name) return res.status(400).json({ error: "legal_name required" });
  const out = await repo.submitKyc(uid, legal_name, kyc_ref || "");
  if ((out as any)?.error) return res.status(400).json({ error: (out as any).error });
  res.json({ kyc: out, payout: "DARK", note: "KYC recorded; payouts remain DARK until money is enabled" });
}));

// v4.0: advance KYC state (test-mode); money stays DARK regardless.
identityRouter.post("/me/kyc/advance", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const { to } = req.body ?? {};
  if (!["pending", "verified", "rejected"].includes(to)) return res.status(400).json({ error: "to must be pending|verified|rejected" });
  const out = await repo.advanceKyc(uid, to);
  if ((out as any)?.error) return res.status(409).json({ error: (out as any).error });
  res.json(out);
}));

// v4.0 own-and-move: import a portable export bundle into the current account.
identityRouter.post("/me/import", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const out = await repo.importPortable(uid, req.body?.bundle ?? req.body);
  if ((out as any)?.error) return res.status(400).json({ error: (out as any).error });
  res.status(201).json(out);
}));

// Admin: stamp expired grants as revoked (cosmetic; enforcement is already on-read).
identityRouter.post("/admin/sweep-expired-grants", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.isStaff(uid))) return res.status(403).json({ error: "staff only" });
  res.json({ swept: await repo.sweepExpiredGrants() });
}));

// Admin: set a user's role_flags — the ONLY path to privileged (admin/verifier) roles.
identityRouter.put("/admin/users/:userId/roles", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.isStaff(uid))) return res.status(403).json({ error: "staff only" });
  const flags = req.body?.role_flags;
  if (!Array.isArray(flags) || !flags.length) return res.status(400).json({ error: "role_flags[] required" });
  const bad = flags.find((f: string) => !FROZEN_ROLES.includes(f as Role));
  if (bad) return res.status(400).json({ error: `invalid role: ${bad}`, allowed: FROZEN_ROLES });
  const out = await repo.setUserRoles(req.params.userId, flags);
  if ((out as any)?.error) return res.status(400).json({ error: (out as any).error });
  res.json({ user: out });
}));

// Requester withdraws their own pending request.
identityRouter.post("/access-requests/:reqId/withdraw", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const ok = await repo.withdrawRequest(req.params.reqId, uid);
  if (!ok) return res.status(403).json({ error: "cannot withdraw (not your pending request)" });
  res.json({ withdrawn: true, id: req.params.reqId });
}));

// Consent audit trail — rights-holder + staff only.
identityRouter.get("/athletes/:id/consent-audit", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.canApproveFor(req.params.id, uid)) && !(await repo.ownsAthlete(req.params.id, uid)))
    return res.status(403).json({ error: "forbidden" });
  res.json({ audit: await repo.auditForAthlete(req.params.id) });
}));

// ---- CONSENT RECEIPTS (ed25519, tamper-evident, hash-chained) ----
identityRouter.get("/athletes/:id/consent-receipts", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.canApproveFor(req.params.id, uid)) && !(await repo.ownsAthlete(req.params.id, uid)))
    return res.status(403).json({ error: "forbidden" });
  res.json({ receipts: await repo.listReceipts(req.params.id) });
}));

// Verify a single receipt (signature + hash). Open to any authenticated caller
// so a scout/third-party can confirm a consent claim without seeing other data.
identityRouter.get("/consent-receipts/:receiptId/verify", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const out = await repo.verifyReceipt(req.params.receiptId);
  res.json(out);
}));

// The signing public key, so verifiers/CW13 can confirm the signer.
identityRouter.get("/consent-receipts/pubkey", wrap(async (_req, res) => {
  const { publicKeyB64, keysFromEnv } = await import("../lib/atlas_sign.js");
  res.json({ alg: "ed25519", public_key_b64: publicKeyB64(), from_env: keysFromEnv });
}));

// ====================================================================
// DPDP/GDPR — DATA EXPORT + ERASURE
// ====================================================================
// Export everything CW9 holds about the caller (self-service portability).
identityRouter.get("/me/export", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  res.json(await repo.exportSubject(uid));
}));

// A parent may export a minor they have a consented link to.
identityRouter.get("/athletes/:id/export", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!(await repo.canApproveFor(req.params.id, uid)) && !(await repo.ownsAthlete(req.params.id, uid)))
    return res.status(403).json({ error: "forbidden" });
  // resolve the athlete's owning user, then export that subject
  const g = await repo.athleteOwnerUser(req.params.id);
  if (!g) return res.status(404).json({ error: "not found" });
  res.json(await repo.exportSubject(g));
}));

// File an erasure request (subject for self, or parent for their minor's owner).
identityRouter.post("/me/erasure-request", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  if (!uid) return res.status(401).json({ error: "unauthenticated" });
  const out = await repo.requestErasure(uid, uid, req.body?.reason);
  if ((out as any)?.error) return res.status(400).json({ error: (out as any).error });
  res.status(201).json({ request: out });
}));

// Staff decide + execute (crypto-erasure preserves the audit/receipt chains).
identityRouter.post("/admin/erasure/:reqId/decide", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  const decision = req.body?.decision;
  if (!["approved", "denied"].includes(decision)) return res.status(400).json({ error: "decision must be approved|denied" });
  const out = await repo.decideErasure(req.params.reqId, uid, decision);
  if (!out.ok) return res.status(403).json({ error: out.reason });
  res.json(out);
}));

identityRouter.post("/admin/erasure/:reqId/execute", wrap(async (req, res) => {
  const uid = req.session?.sub ?? null;
  const out = await repo.executeErasure(req.params.reqId, uid);
  if (!out.ok) return res.status(out.reason === "staff only" ? 403 : 409).json({ error: out.reason });
  res.json(out);
}));
