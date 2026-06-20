// src/lib/repo.ts
// Repository that picks the real Supabase backend when env is present, else the
// in-memory mock. Routes call this; they never branch on LIVE themselves.

import { LIVE, service, rlsRead } from "./db";
import { store, FROZEN_ROLES, isMinor, type Role } from "../mocks/store";

export { FROZEN_ROLES, type Role };

export interface MeShape { id: string; name: string; email: string; dob?: string; role_flags: string[]; }

/** Offline/dev token: alg:none JWT carrying sub (accepted only when SUPABASE_JWT_SECRET unset). */
function mockToken(sub: string): string {
  const h = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${h}.${p}.mock`;
}

export const repo = {
  live: LIVE,

  async findUserByEmail(email: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_users").select("*").eq("email", email).maybeSingle();
      return data ?? null;
    }
    return store.users.find(u => u.email === email) ?? null;
  },

  async createUser(u: { email: string; name: string; dob?: string; role_flags: Role[] }) {
    if (LIVE && service) {
      const { data, error } = await service.from("sports_users")
        .insert({ email: u.email, name: u.name, dob: u.dob ?? null, role_flags: u.role_flags })
        .select().single();
      if (error) throw error;
      return data;
    }
    const user = { id: `u-${Math.random().toString(16).slice(2, 10)}`, ...u, created_at: new Date().toISOString() };
    store.users.push(user as any);
    return user;
  },

  async getMe(uid: string): Promise<MeShape | null> {
    if (LIVE && service) {
      const { data } = await service.from("sports_users")
        .select("id,name,email,dob,role_flags").eq("id", uid).maybeSingle();
      return (data as MeShape) ?? null;
    }
    const me = store.userById(uid);
    return me ? { id: me.id, name: me.name, email: me.email, dob: me.dob, role_flags: me.role_flags } : null;
  },

  // ===== REAL SUPABASE AUTH (email + Google) =====
  // Live: Supabase Auth issues the verifiable JWT; we mirror the user into
  // sports_users with role_flags. Mock: issue a local alg:none token.
  async signupEmail(email: string, password: string, name: string, role_flags: Role[], dob?: string) {
    if (LIVE && service) {
      // create the auth user (admin API, email confirmed for first-party signup)
      const { data: created, error: authErr } = await (service as any).auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { name },
      });
      if (authErr) return { error: authErr.message };
      const authId = created.user.id;
      // mirror into sports_users using the SAME id so RLS sub matches
      const { error: rowErr } = await service.from("sports_users")
        .insert({ id: authId, email, name, dob: dob ?? null, role_flags });
      if (rowErr) return { error: rowErr.message };
      // issue a session (password grant) so the client gets a token immediately
      const { data: sess } = await (service as any).auth.signInWithPassword({ email, password });
      return { user: { id: authId, email, name, role_flags }, token: sess?.session?.access_token ?? null };
    }
    // mock
    const u = await this.createUser({ email, name, dob, role_flags });
    return { user: u, token: mockToken((u as any).id) };
  },

  async loginEmail(email: string, password: string) {
    if (LIVE && service) {
      const { data, error } = await (service as any).auth.signInWithPassword({ email, password });
      if (error) return { error: error.message };
      const uid = data.user.id;
      const me = await this.getMe(uid);
      return { user: me, token: data.session?.access_token ?? null };
    }
    const u = store.users.find(x => x.email === email);
    if (!u) return { error: "no such user" };
    return { user: u, token: mockToken(u.id) };
  },

  // ===== ATHLETE DATA OWNERSHIP FRAMEWORK (v3.0) =====
  /** v4.0 own-and-move: import a portable export bundle into the CURRENT account.
   *  Creates an athlete owned by the importing user from the bundle's data.
   *  Grants/receipts are NOT blindly imported (they reference other users); we
   *  import the athlete profile + a fresh ownership assertion. Honest by design:
   *  we re-home the data the user owns, not other people's access to it. */
  async importPortable(targetUid: string, bundle: any) {
    if (!bundle || bundle.format !== "dcs-sports-cw9-export/v1") return { error: "unrecognized export format" };
    const src = bundle.athletes?.[0] ?? null;
    if (!src) return { error: "no athlete in bundle" };
    // create a new athlete under the importing user
    let newId: string;
    if (LIVE && service) {
      const { data, error } = await service.from("sports_athletes")
        .insert({ user_id: targetUid, sport: src.sport ?? "cricket", role: src.role ?? null, dob: src.dob ?? null, visibility: "private" })
        .select("id").single();
      if (error) return { error: error.message };
      newId = data.id;
    } else {
      newId = `ath-import-${store.athletes.length + 1}`;
      store.athletes.push({ id: newId, user_id: targetUid, sport: src.sport ?? "cricket", role: src.role, dob: src.dob, visibility: "private" } as any);
    }
    await this.establishOwnership(newId, targetUid, null);
    // re-home profile fields if present
    if (bundle.profile) await this.upsertProfile(targetUid, { display_name: bundle.profile.display_name, bio: bundle.profile.bio, site_json: bundle.profile.site_json ?? {} });
    return { ok: true, imported_athlete_id: newId, ownership: "established", note: "data re-homed under the importing account; visibility reset to private; prior third-party grants NOT carried over" };
  },

  // ===== PAYOUT-KYC verify state machine (v4.0, still DARK) =====
  /** Advance KYC state (test-mode): unsubmitted→pending→verified|rejected. Money stays DARK. */
  async advanceKyc(uid: string, toStatus: "pending" | "verified" | "rejected") {
    const cur = await this.getKyc(uid);
    if (!cur) return { error: "no kyc on file" };
    const allowed: Record<string, string[]> = { unsubmitted: ["pending"], pending: ["verified", "rejected"], verified: [], rejected: ["pending"] };
    if (!allowed[cur.status]?.includes(toStatus)) return { error: `illegal transition ${cur.status} -> ${toStatus}` };
    const row = { ...cur, status: toStatus, payout_dark: true, updated_at: new Date().toISOString() };
    if (LIVE && service) {
      const { data, error } = await service.from("sports_payout_kyc").update({ status: toStatus, updated_at: row.updated_at }).eq("user_id", uid).select().single();
      if (error) return { error: error.message };
      return { ok: true, kyc: data, payout: "DARK" };
    }
    store.kyc[uid] = row; return { ok: true, kyc: row, payout: "DARK" };
  },

  /** Establish/get the athlete as the owner of their data (acts_via = parent for a minor). */
  async establishOwnership(athleteId: string, ownerUid: string, actsVia?: string | null) {
    if (LIVE && service) {
      const { data, error } = await service.from("sports_data_ownership")
        .upsert({ athlete_id: athleteId, owner_user: ownerUid, acts_via: actsVia ?? null }, { onConflict: "athlete_id" })
        .select().single();
      if (error) return { error: error.message };
      return data;
    }
    const row = { athlete_id: athleteId, owner_user: ownerUid, acts_via: actsVia ?? null, portable: true, established_at: new Date().toISOString() };
    store.ownership[athleteId] = row; return row;
  },

  async getOwnership(athleteId: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_data_ownership").select("*").eq("athlete_id", athleteId).maybeSingle();
      return data ?? null;
    }
    return store.ownership[athleteId] ?? null;
  },

  /** Portable ownership manifest: who owns this athlete's data, every active grant
   *  they've issued, and the assertion that it's portable + revocable. */
  async ownershipManifest(athleteId: string) {
    const owner = await this.getOwnership(athleteId);
    const grants = LIVE && service
      ? ((await service.from("sports_data_access_grants").select("*").eq("athlete_id", athleteId).is("revoked_at", null)).data ?? [])
      : store.grants.filter(g => g.athlete_id === athleteId && !g.revoked_at);
    return {
      manifest: "dcs-sports-ownership/v1",
      athlete_id: athleteId,
      owner,
      principle: "The athlete owns their profile, video, access and sponsor grants. Portable and revocable at any time.",
      active_grants: grants,
      revocable: true,
      portable: owner?.portable ?? true,
      generated_at: new Date().toISOString(),
    };
  },

  // ===== PAYOUT-KYC SHELL (DARK) =====
  async getKyc(uid: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_payout_kyc").select("*").eq("user_id", uid).maybeSingle();
      return data ?? null;
    }
    return store.kyc[uid] ?? null;
  },

  /** Record KYC intent — DARK. No money moves; payout_dark stays true. No raw IDs. */
  async submitKyc(uid: string, legalName: string, kycRef: string) {
    const row = { user_id: uid, legal_name: legalName, kyc_ref: kycRef, status: "pending", payout_dark: true, updated_at: new Date().toISOString() };
    if (LIVE && service) {
      const { data, error } = await service.from("sports_payout_kyc").upsert(row, { onConflict: "user_id" }).select().single();
      if (error) return { error: error.message };
      return data;
    }
    store.kyc[uid] = row; return row;
  },

  // ===== ORG / FEDERATION + ROLE DELEGATION (v2.0) =====
  async createOrg(kind: string, name: string, ownerUid: string | null, parentOrg?: string | null) {
    if (LIVE && service) {
      const { data, error } = await service.from("sports_orgs")
        .insert({ kind, name, owner_user: ownerUid, parent_org: parentOrg ?? null }).select().single();
      if (error) return { error: error.message };
      // owner becomes org_admin
      if (data) await service.from("sports_org_members").insert({ org_id: data.id, user_id: ownerUid, org_role: "org_admin", delegated_by: ownerUid });
      return data;
    }
    const org = { id: `org-${store.orgs.length + 1}`, kind, name, owner_user: ownerUid, parent_org: parentOrg ?? null, created_at: new Date().toISOString() };
    store.orgs.push(org as any);
    store.orgMembers.push({ id: `om-${store.orgMembers.length + 1}`, org_id: org.id, user_id: ownerUid, org_role: "org_admin", delegated_by: ownerUid } as any);
    return org;
  },

  async isOrgAdmin(orgId: string, uid: string | null): Promise<boolean> {
    if (!uid) return false;
    if (await this.isStaff(uid)) return true;
    if (LIVE && service) {
      const { data } = await service.from("sports_org_members").select("id").eq("org_id", orgId).eq("user_id", uid).eq("org_role", "org_admin").maybeSingle();
      return Boolean(data);
    }
    return store.orgMembers.some(m => m.org_id === orgId && m.user_id === uid && m.org_role === "org_admin");
  },

  async listOrgMembers(orgId: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_org_members").select("*").eq("org_id", orgId);
      return data ?? [];
    }
    return store.orgMembers.filter(m => m.org_id === orgId);
  },

  /** Delegate an ORG-SCOPED role. Never grants global staff power. Audited. */
  async delegateOrgRole(orgId: string, actorUid: string | null, targetUid: string, orgRole: string) {
    if (!(await this.isOrgAdmin(orgId, actorUid))) return { ok: false, reason: "org admin only" };
    const allowed = ["org_admin", "org_coach", "org_scout", "org_viewer"];
    if (!allowed.includes(orgRole)) return { ok: false, reason: "invalid org role" };
    if (LIVE && service) {
      const { error } = await service.from("sports_org_members").insert({ org_id: orgId, user_id: targetUid, org_role: orgRole, delegated_by: actorUid });
      if (error && !/duplicate/i.test(error.message)) return { ok: false, reason: error.message };
      await service.from("sports_org_delegation_audit").insert({ org_id: orgId, actor_id: actorUid, target_id: targetUid, org_role: orgRole, action: "granted" });
      return { ok: true };
    }
    if (!store.orgMembers.some(m => m.org_id === orgId && m.user_id === targetUid && m.org_role === orgRole))
      store.orgMembers.push({ id: `om-${store.orgMembers.length + 1}`, org_id: orgId, user_id: targetUid, org_role: orgRole, delegated_by: actorUid } as any);
    store.orgDelegationAudit.push({ id: `oda-${store.orgDelegationAudit.length + 1}`, org_id: orgId, actor_id: actorUid, target_id: targetUid, org_role: orgRole, action: "granted", ts: new Date().toISOString() } as any);
    return { ok: true };
  },

  async revokeOrgRole(orgId: string, actorUid: string | null, targetUid: string, orgRole: string) {
    if (!(await this.isOrgAdmin(orgId, actorUid))) return { ok: false, reason: "org admin only" };
    if (LIVE && service) {
      await service.from("sports_org_members").delete().eq("org_id", orgId).eq("user_id", targetUid).eq("org_role", orgRole);
      await service.from("sports_org_delegation_audit").insert({ org_id: orgId, actor_id: actorUid, target_id: targetUid, org_role: orgRole, action: "revoked" });
      return { ok: true };
    }
    store.orgMembers = store.orgMembers.filter(m => !(m.org_id === orgId && m.user_id === targetUid && m.org_role === orgRole));
    store.orgDelegationAudit.push({ id: `oda-${store.orgDelegationAudit.length + 1}`, org_id: orgId, actor_id: actorUid, target_id: targetUid, org_role: orgRole, action: "revoked", ts: new Date().toISOString() } as any);
    return { ok: true };
  },

  async orgDelegationAudit(orgId: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_org_delegation_audit").select("*").eq("org_id", orgId).order("ts", { ascending: false });
      return data ?? [];
    }
    return store.orgDelegationAudit.filter(a => a.org_id === orgId);
  },

  // ===== MINOR-DATA ACCESS AUDIT (mandate item 6) =====
  /** Record a third-party READ of a minor's data. Best-effort, non-blocking.
   *  Only logs when subject is a minor AND viewer is NOT owner/parent/staff. */
  async logMinorAccess(athleteId: string, viewerId: string | null, scope: string, surface: string) {
    try {
      if (!viewerId) return;
      // determine minor + third-party via service role (avoids RLS recursion)
      if (LIVE && service) {
        const { data: a } = await service.from("sports_athletes").select("user_id,dob").eq("id", athleteId).maybeSingle();
        if (!a) return;
        const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 18);
        const minor = a.dob && new Date(a.dob) > cutoff;
        if (!minor) return;
        if (a.user_id === viewerId) return;                       // self
        const { data: pl } = await service.from("sports_parent_links").select("consent").eq("athlete_id", athleteId).eq("parent_user_id", viewerId).maybeSingle();
        if (pl?.consent) return;                                  // consented parent
        if (await this.isStaff(viewerId)) return;                 // staff
        await service.from("sports_minor_access_log").insert({ athlete_id: athleteId, viewer_id: viewerId, scope, surface });
        return;
      }
      // mock
      const a = store.athleteById(athleteId);
      if (!a || !isMinor(a.dob)) return;
      if (a.user_id === viewerId) return;
      if (store.parentLinks.some(p => p.athlete_id === athleteId && p.parent_user_id === viewerId && p.consent)) return;
      if (store.isStaff(viewerId)) return;
      store.minorAccess.push({ id: `ma-${store.minorAccess.length + 1}`, athlete_id: athleteId, viewer_id: viewerId, scope, surface, ts: new Date().toISOString() });
    } catch (e) {
      console.error("[CW9] minor-access log failed (non-blocking):", (e as Error).message);
    }
  },

  async minorAccessLog(athleteId: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_minor_access_log").select("*").eq("athlete_id", athleteId).order("ts", { ascending: false });
      return data ?? [];
    }
    return store.minorAccess.filter(m => m.athlete_id === athleteId);
  },

  // ===== DPDP/GDPR: DATA EXPORT + ERASURE =====
  async setUserRoles(userId: string, flags: string[]) {
    if (LIVE && service) {
      const { data, error } = await service.from("sports_users")
        .update({ role_flags: flags }).eq("id", userId).select("id,name,email,role_flags").single();
      if (error) return { error: error.message };
      return data;
    }
    const u = store.userById(userId);
    if (!u) return { error: "no such user" };
    u.role_flags = flags as any;
    return { id: u.id, name: u.name, email: u.email, role_flags: u.role_flags };
  },

  async athleteOwnerUser(athleteId: string): Promise<string | null> {
    if (LIVE && service) {
      const { data } = await service.from("sports_athletes").select("user_id").eq("id", athleteId).maybeSingle();
      return data?.user_id ?? null;
    }
    return store.athletes.find(a => a.id === athleteId)?.user_id ?? null;
  },

  /** Portable export: everything CW9 holds about a subject user (+ their athletes). */
  async exportSubject(userId: string) {
    if (LIVE && service) {
      const athletes = (await service.from("sports_athletes").select("*").eq("user_id", userId)).data ?? [];
      const aIds = athletes.map((a: any) => a.id);
      const inA = (q: any) => aIds.length ? q.in("athlete_id", aIds) : q.eq("athlete_id", "00000000-0000-0000-0000-000000000000");
      const [user, profile, grants, links, requests, audit, receipts] = await Promise.all([
        service.from("sports_users").select("*").eq("id", userId).maybeSingle(),
        service.from("sports_profiles").select("*").eq("user_id", userId).maybeSingle(),
        inA(service.from("sports_data_access_grants").select("*")),
        service.from("sports_parent_links").select("*").or(`parent_user_id.eq.${userId}`),
        inA(service.from("sports_access_requests").select("*")),
        inA(service.from("sports_consent_audit").select("*")),
        inA(service.from("sports_consent_receipts").select("*")),
      ]);
      return {
        exported_at: new Date().toISOString(), subject_user_id: userId, format: "dcs-sports-cw9-export/v1",
        user: user.data, profile: profile.data, athletes,
        data_access_grants: grants.data ?? [], parent_links: links.data ?? [],
        access_requests: requests.data ?? [], consent_audit: audit.data ?? [], consent_receipts: receipts.data ?? [],
      };
    }
    // mock
    const u = store.userById(userId);
    const athletes = store.athletes.filter(a => a.user_id === userId);
    const aIds = new Set(athletes.map(a => a.id));
    return {
      exported_at: new Date().toISOString(), subject_user_id: userId, format: "dcs-sports-cw9-export/v1",
      user: u, profile: store.profiles[userId] ?? null, athletes,
      data_access_grants: store.grants.filter(g => aIds.has(g.athlete_id)),
      parent_links: store.parentLinks.filter(p => p.parent_user_id === userId || aIds.has(p.athlete_id)),
      access_requests: store.accessRequests.filter(r => aIds.has(r.athlete_id)),
      consent_audit: store.audit.filter(a => a.athlete_id && aIds.has(a.athlete_id)),
      consent_receipts: store.receipts.filter((r: any) => aIds.has(r.athlete_id)),
    };
  },

  async requestErasure(subjectUserId: string, requestedBy: string, reason?: string) {
    if (LIVE && service) {
      const { data, error } = await service.from("sports_erasure_requests")
        .insert({ subject_user_id: subjectUserId, requested_by: requestedBy, reason }).select().single();
      if (error) return { error: error.message };
      return data;
    }
    const r = { id: `er-${store.erasures.length + 1}`, subject_user_id: subjectUserId, requested_by: requestedBy, reason, status: "pending", created_at: new Date().toISOString() };
    store.erasures.push(r as any); return r;
  },

  async decideErasure(reqId: string, staffId: string | null, decision: "approved" | "denied") {
    if (!(await this.isStaff(staffId))) return { ok: false, reason: "staff only" };
    if (LIVE && service) {
      await service.from("sports_erasure_requests").update({ status: decision, decided_by: staffId }).eq("id", reqId);
      return { ok: true, status: decision };
    }
    const r = store.erasures.find((x: any) => x.id === reqId);
    if (!r) return { ok: false, reason: "not found" };
    r.status = decision; r.decided_by = staffId; return { ok: true, status: decision };
  },

  /** Execute crypto-erasure (staff/service only). Redacts PII, preserves chains. */
  async executeErasure(reqId: string, staffId: string | null) {
    if (!(await this.isStaff(staffId))) return { ok: false, reason: "staff only" };
    if (LIVE && service) {
      const { data: req } = await service.from("sports_erasure_requests").select("*").eq("id", reqId).maybeSingle();
      if (!req) return { ok: false, reason: "not found" };
      if (req.status !== "approved") return { ok: false, reason: "must be approved first" };
      const { data: counts } = await service.rpc("sports_execute_erasure", { p_user: req.subject_user_id });
      await service.from("sports_erasure_requests").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", reqId);
      return { ok: true, counts };
    }
    // mock crypto-erasure: redact PII, keep chains
    const r = store.erasures.find((x: any) => x.id === reqId);
    if (!r) return { ok: false, reason: "not found" };
    if (r.status !== "approved") return { ok: false, reason: "must be approved first" };
    const uid = r.subject_user_id;
    const u = store.userById(uid);
    if (u) { u.email = `erased+${u.id}@erased.invalid`; (u as any).phone = null; u.name = "[erased]"; u.dob = undefined; }
    if (store.profiles[uid]) store.profiles[uid] = { ...store.profiles[uid], display_name: "[erased]", avatar_url: null, bio: null, site_json: {} };
    for (const a of store.athletes.filter(a => a.user_id === uid)) { a.state = undefined; a.district = undefined; a.dob = undefined; a.visibility = "private"; }
    const aIds = new Set(store.athletes.filter(a => a.user_id === uid).map(a => a.id));
    for (const g of store.grants) if ((g.grantee_id === uid || aIds.has(g.athlete_id)) && !g.revoked_at) g.revoked_at = new Date().toISOString();
    // receipts/audit chains preserved; tombstone:
    store.audit.push({ id: `au-${store.audit.length + 1}`, athlete_id: null, actor_id: uid, action: "consent_withdrawn", detail_json: { erasure_executed: true }, ts: new Date().toISOString() } as any);
    r.status = "executed"; (r as any).executed_at = new Date().toISOString();
    return { ok: true, counts: { user_redacted: 1 } };
  },

  // ===== CONSENT RECEIPTS (ed25519, atlas-compatible) =====
  async _lastReceiptHash(athleteId: string | null): Promise<string | null> {
    if (!athleteId) return null;
    if (LIVE && service) {
      const { data } = await service.from("sports_consent_receipts")
        .select("receipt_hash").eq("athlete_id", athleteId).order("signed_at", { ascending: false }).limit(1).maybeSingle();
      return data?.receipt_hash ?? null;
    }
    const chain = store.receipts.filter(r => r.athlete_id === athleteId);
    return chain.length ? chain[chain.length - 1].receipt_hash : null;
  },

  async issueConsentReceipt(athleteId: string | null, subjectType: string, subjectId: string, attestation: string, attestedBy: string | null) {
    try {
      const { issueReceipt } = await import("./atlas_sign.js");
      const prev = await this._lastReceiptHash(athleteId);
      const rcpt = issueReceipt({
        subject_type: subjectType, subject_id: subjectId,
        attestation, attested_by: attestedBy ?? "system", prev_hash: prev,
      });
      const row = {
        athlete_id: athleteId, subject_type: subjectType, subject_id: subjectId,
        attestation, attested_by: attestedBy, prev_hash: prev,
        receipt_hash: rcpt.receipt_hash, sig: rcpt.sig, signed_at: rcpt.signed_at,
      };
      if (LIVE && service) { await service.from("sports_consent_receipts").insert(row); }
      else { store.receipts.push({ id: `rcpt-${store.receipts.length + 1}`, ...row } as any); }
      return rcpt;
    } catch (e) {
      console.error("[CW9] consent receipt issue failed (non-blocking):", (e as Error).message);
      return null;
    }
  },

  async listReceipts(athleteId: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_consent_receipts").select("*").eq("athlete_id", athleteId).order("signed_at", { ascending: true });
      return data ?? [];
    }
    return store.receipts.filter(r => r.athlete_id === athleteId);
  },

  async verifyReceipt(receiptId: string) {
    const { verifyReceiptSig } = await import("./atlas_sign.js");
    let r: any = null;
    if (LIVE && service) {
      const { data } = await service.from("sports_consent_receipts").select("*").eq("id", receiptId).maybeSingle();
      r = data;
    } else {
      r = store.receipts.find((x: any) => x.id === receiptId) ?? null;
    }
    if (!r) return { ok: false, reason: "not found" };
    const sig = verifyReceiptSig({
      subject_type: r.subject_type, subject_id: r.subject_id, attestation: r.attestation,
      attested_by: r.attested_by ?? "system", prev_hash: r.prev_hash ?? null,
      receipt_hash: r.receipt_hash, sig: r.sig, signed_at: r.signed_at,
    });
    return { ...sig, receipt: r };
  },

  // ===== PROFILES · BUILDER · PUBLISH · SUBSCRIPTION (DARK) =====
  async getProfile(uid: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_profiles").select("*").eq("user_id", uid).maybeSingle();
      return data ?? null;
    }
    return store.profiles[uid] ?? null;
  },

  async upsertProfile(uid: string, patch: Record<string, unknown>) {
    const safe = { ...patch }; delete (safe as any).sub_dark; delete (safe as any).published_at;
    if (LIVE && service) {
      const { data, error } = await service.from("sports_profiles")
        .upsert({ user_id: uid, ...safe, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
        .select().single();
      if (error) return { error: error.message };
      return data;
    }
    const cur = store.profiles[uid] ?? { user_id: uid, published: false, sub_tier: "free", sub_status: "inactive", sub_dark: true, site_json: {} };
    store.profiles[uid] = { ...cur, ...safe, updated_at: new Date().toISOString() };
    return store.profiles[uid];
  },

  async publishProfile(uid: string, publish: boolean) {
    const p = (await this.getProfile(uid)) ?? {};
    if (publish && (!p.site_slug || !p.site_json || JSON.stringify(p.site_json) === "{}"))
      return { error: "cannot publish: site_slug and non-empty site_json required" };
    if (LIVE && service) {
      const { data, error } = await service.from("sports_profiles")
        .update({ published: publish, ...(publish ? { published_at: new Date().toISOString() } : {}) })
        .eq("user_id", uid).select().single();
      if (error) return { error: error.message };
      return data;
    }
    store.profiles[uid] = { ...p, user_id: uid, published: publish, published_at: publish ? new Date().toISOString() : p.published_at };
    return store.profiles[uid];
  },

  async setSubscription(uid: string, tier: string, status: string) {
    if (LIVE && service) {
      const { data, error } = await service.from("sports_profiles")
        .upsert({ user_id: uid, sub_tier: tier, sub_status: status, sub_dark: true, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
        .select().single();
      if (error) return { error: error.message };
      return data;
    }
    const cur = store.profiles[uid] ?? { user_id: uid, published: false, site_json: {} };
    store.profiles[uid] = { ...cur, sub_tier: tier, sub_status: status, sub_dark: true };
    return store.profiles[uid];
  },

  // ----- PASSWORD RESET (Supabase recovery flow) -----
  async requestPasswordReset(email: string, redirectTo: string) {
    if (LIVE && service) {
      const { error } = await (service as any).auth.resetPasswordForEmail(email, { redirectTo });
      // Always return ok (don't leak whether the email exists).
      if (error) console.error("[CW9] reset email error:", error.message);
      return { ok: true };
    }
    // mock: pretend an email was sent
    return { ok: true, mock: true };
  },

  /** Update password using a recovery access token (from the email link). */
  async updatePassword(recoveryToken: string, newPassword: string) {
    if (LIVE && service) {
      // build a user-scoped client from the recovery token, then updateUser
      try {
        const { createClient } = await import("@supabase/supabase-js");
        const url = process.env.SUPABASE_URL!;
        const anon = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const userClient = createClient(url, anon, {
          global: { headers: { Authorization: `Bearer ${recoveryToken}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { error } = await userClient.auth.updateUser({ password: newPassword });
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    return { ok: true, mock: true };
  },

  // Google OAuth: return the provider redirect URL the client opens.
  async googleAuthUrl(redirectTo: string) {
    if (LIVE && service) {
      const { data, error } = await (service as any).auth.signInWithOAuth({
        provider: "google", options: { redirectTo },
      });
      if (error) return { error: error.message };
      return { url: data?.url ?? null };
    }
    return { url: `${redirectTo}#mock_google_oauth` };
  },

  async isStaff(uid: string | null): Promise<boolean> {
    if (!uid) return false;
    if (LIVE && service) {
      const { data } = await service.from("sports_users").select("role_flags").eq("id", uid).maybeSingle();
      const f: string[] = data?.role_flags ?? [];
      return f.includes("admin") || f.includes("verifier");
    }
    return store.isStaff(uid);
  },

  async ownsAthlete(athleteId: string, uid: string | null): Promise<boolean> {
    if (!uid) return false;
    if (LIVE && service) {
      const { data } = await service.from("sports_athletes").select("user_id").eq("id", athleteId).maybeSingle();
      return data?.user_id === uid || (await this.isStaff(uid));
    }
    const a = store.athletes.find(x => x.id === athleteId);
    return !!a && (a.user_id === uid || store.isStaff(uid));
  },

  async listGrants(athleteId: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_data_access_grants").select("*").eq("athlete_id", athleteId);
      return data ?? [];
    }
    return store.grants.filter(g => g.athlete_id === athleteId);
  },

  async addGrant(athleteId: string, granteeId: string, scope: string, expiresAt?: string | null) {
    let g: any;
    if (LIVE && service) {
      const { data, error } = await service.from("sports_data_access_grants")
        .insert({ athlete_id: athleteId, grantee_id: granteeId, scope, expires_at: expiresAt ?? null }).select().single();
      if (error) throw error;
      g = data;
    } else {
      g = store.addGrant(athleteId, granteeId, scope as any, expiresAt ?? null);
    }
    await this.issueConsentReceipt(athleteId, "grant", String(g.id), "grant_created", granteeId);
    return g;
  },

  async revokeGrant(grantId: string) {
    const g = await this.grantById(grantId);
    let ok: boolean;
    if (LIVE && service) {
      const { data } = await service.from("sports_data_access_grants")
        .update({ revoked_at: new Date().toISOString() }).eq("id", grantId).select().maybeSingle();
      ok = Boolean(data);
    } else {
      ok = store.revokeGrant(grantId);
    }
    if (ok && g) await this.issueConsentReceipt(g.athlete_id ?? null, "grant", String(grantId), "grant_revoked", null);
    return ok;
  },

  async sweepExpiredGrants(): Promise<number> {
    if (LIVE && service) {
      const { data } = await service.rpc("sports_sweep_expired_grants");
      return Number(data ?? 0);
    }
    let n = 0;
    for (const g of store.grants) {
      if (!g.revoked_at && g.expires_at && new Date(g.expires_at) <= new Date()) { g.revoked_at = new Date().toISOString(); n++; }
    }
    return n;
  },

  async grantById(grantId: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_data_access_grants").select("*").eq("id", grantId).maybeSingle();
      return data ?? null;
    }
    return store.grants.find(x => x.id === grantId) ?? null;
  },

  // ---- grant renewal: extend expiry without breaking the audit chain ----
  async renewGrant(grantId: string, newExpiry: string | null) {
    if (LIVE && service) {
      const patch: Record<string, unknown> = { expires_at: newExpiry };
      // reactivate a still-valid grant that had lapsed/been revoked-by-sweep
      if (!newExpiry || new Date(newExpiry) > new Date()) patch.revoked_at = null;
      const { data } = await service.from("sports_data_access_grants").update(patch).eq("id", grantId).select().maybeSingle();
      return data ?? null;
    }
    return store.renewGrant(grantId, newExpiry);
  },

  // ---- bulk console: all active grants across the athletes a user controls ----
  async athletesControlledBy(uid: string | null): Promise<string[]> {
    if (!uid) return [];
    if (LIVE && service) {
      const [{ data: owned }, { data: asParent }] = await Promise.all([
        service.from("sports_athletes").select("id").eq("user_id", uid),
        service.from("sports_parent_links").select("athlete_id").eq("parent_user_id", uid).eq("consent", true),
      ]);
      const ids = [...(owned ?? []).map((a: any) => a.id), ...(asParent ?? []).map((p: any) => p.athlete_id)];
      return Array.from(new Set(ids));
    }
    return store.athletesControlledBy(uid);
  },

  async activeGrantsControlledBy(uid: string | null) {
    if (LIVE && service) {
      const ids = await this.athletesControlledBy(uid);
      if (!ids.length) return [];
      const { data } = await service.from("sports_data_access_grants")
        .select("*").in("athlete_id", ids).is("revoked_at", null);
      const now = Date.now();
      return (data ?? []).filter((g: any) => !g.expires_at || new Date(g.expires_at).getTime() > now);
    }
    return store.activeGrantsControlledBy(uid);
  },

  async grantsExpiringSoon(uid: string | null, days: number) {
    if (LIVE && service) {
      const active = await this.activeGrantsControlledBy(uid);
      const now = Date.now(); const horizon = now + days * 86400000;
      return (active as any[]).filter(g => g.expires_at && new Date(g.expires_at).getTime() <= horizon && new Date(g.expires_at).getTime() > now);
    }
    return store.grantsExpiringSoon(uid, days);
  },

  async setConsent(athleteId: string, parentUid: string, consent: boolean) {
    let result: any;
    if (LIVE && service) {
      const { data } = await service.from("sports_parent_links")
        .update({ consent, consented_at: new Date().toISOString() })
        .eq("athlete_id", athleteId).eq("parent_user_id", parentUid).select().maybeSingle();
      result = data ?? null;
    } else {
      const link = store.parentLinks.find(p => p.athlete_id === athleteId && p.parent_user_id === parentUid);
      if (!link) { result = null; }
      else { link.consent = consent; link.consented_at = new Date().toISOString(); result = link; }
    }
    if (result) await this.issueConsentReceipt(athleteId, "consent", `${athleteId}:${parentUid}`,
      consent ? "parent_consent_granted" : "parent_consent_withdrawn", parentUid);
    return result;
  },

  async adminOverview() {
    if (LIVE && service) {
      const [{ count: users }, { count: athletes }, { data: grants }, { data: allUsers }, { data: minors }] =
        await Promise.all([
          service.from("sports_users").select("*", { count: "exact", head: true }),
          service.from("sports_athletes").select("*", { count: "exact", head: true }),
          service.from("sports_data_access_grants").select("id").is("revoked_at", null),
          service.from("sports_users").select("role_flags"),
          service.from("sports_athletes").select("dob"),
        ]);
      const roleCounts: Record<string, number> = {};
      for (const u of allUsers ?? []) for (const r of (u.role_flags ?? [])) roleCounts[r] = (roleCounts[r] ?? 0) + 1;
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 18);
      const minorsProtected = (minors ?? []).filter(m => m.dob && new Date(m.dob) > cutoff).length;
      return {
        users: users ?? 0, athletes: athletes ?? 0,
        active_grants: (grants ?? []).length, minors_protected: minorsProtected,
        role_distribution: roleCounts,
        minor_discoverability: "DARK (DK + counsel gated)", money: "DARK",
      };
    }
    // mock
    const roleCounts: Record<string, number> = {};
    for (const u of store.users) for (const r of u.role_flags) roleCounts[r] = (roleCounts[r] ?? 0) + 1;
    const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 18);
    return {
      users: store.users.length, athletes: store.athletes.length,
      active_grants: store.grants.filter(g => !g.revoked_at).length,
      minors_protected: store.athletes.filter(a => a.dob && new Date(a.dob) > cutoff).length,
      role_distribution: roleCounts,
      minor_discoverability: "DARK (DK + counsel gated)", money: "DARK",
    };
  },

  /** RLS-respecting athlete read for a given viewer (uses rlsRead when live). */
  async athletesVisibleTo(uid: string | null) {
    if (LIVE) {
      return rlsRead(uid, "select id, role, visibility, sport from sports_athletes");
    }
    return store.athletes.filter(a => store.canReadAthlete(a, uid))
      .map(a => ({ id: a.id, role: a.role, visibility: a.visibility, sport: a.sport }));
  },

  // ---- R2: access-request lifecycle + co-consent + audit ----
  async canApproveFor(athleteId: string, actor: string | null): Promise<boolean> {
    if (!actor) return false;
    if (LIVE && service) {
      const { data: a } = await service.from("sports_athletes").select("user_id,dob").eq("id", athleteId).maybeSingle();
      if (!a) return false;
      if (await this.isStaff(actor)) return true;
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 18);
      const minor = a.dob && new Date(a.dob) > cutoff;
      if (!minor) return a.user_id === actor;
      const { data: pl } = await service.from("sports_parent_links")
        .select("consent").eq("athlete_id", athleteId).eq("parent_user_id", actor).maybeSingle();
      return Boolean(pl?.consent);
    }
    return store.canApproveFor(athleteId, actor);
  },

  async createRequest(athleteId: string, requesterId: string, scope: string, reason?: string) {
    if (LIVE && service) {
      const { data, error } = await service.from("sports_access_requests")
        .insert({ athlete_id: athleteId, requester_id: requesterId, scope, reason }).select().single();
      if (error) return { error: error.message };
      await service.from("sports_consent_audit").insert({ athlete_id: athleteId, actor_id: requesterId, action: "request_created", scope });
      return data;
    }
    return store.createRequest(athleteId, requesterId, scope as any, reason);
  },

  async decideRequest(reqId: string, actor: string | null, decision: "approved" | "denied", expiresAt?: string | null): Promise<{ ok: boolean; reason?: string; grant?: unknown }> {
    if (!(await this.canApproveFor((await this.requestById(reqId))?.athlete_id ?? "", actor)))
      return { ok: false, reason: "not authorized (minor requires a consented parent)" };
    if (LIVE && service) {
      const r = await this.requestById(reqId);
      if (!r || r.status !== "pending") return { ok: false, reason: "not pending" };
      await service.from("sports_access_requests").update({ status: decision, decided_by: actor, decided_at: new Date().toISOString() }).eq("id", reqId);
      await service.from("sports_consent_audit").insert({ athlete_id: r.athlete_id, actor_id: actor, action: decision === "approved" ? "request_approved" : "request_denied", scope: r.scope });
      if (decision === "approved") {
        const { data: g } = await service.from("sports_data_access_grants").insert({ athlete_id: r.athlete_id, grantee_id: r.requester_id, scope: r.scope, expires_at: expiresAt ?? null }).select().single();
        await service.from("sports_consent_audit").insert({ athlete_id: r.athlete_id, actor_id: actor, action: "grant_created", scope: r.scope });
        return { ok: true, grant: g };
      }
      return { ok: true };
    }
    return store.decideRequest(reqId, actor, decision, expiresAt ?? null);
  },

  async withdrawRequest(reqId: string, actor: string | null) {
    if (LIVE && service) {
      const r = await this.requestById(reqId);
      if (!r || r.requester_id !== actor || r.status !== "pending") return false;
      await service.from("sports_access_requests").update({ status: "withdrawn" }).eq("id", reqId);
      await service.from("sports_consent_audit").insert({ athlete_id: r.athlete_id, actor_id: actor, action: "request_withdrawn", scope: r.scope });
      return true;
    }
    return store.withdrawRequest(reqId, actor);
  },

  async requestById(reqId: string): Promise<{ id: string; athlete_id: string; requester_id: string; scope: string; status: string } | null> {
    if (LIVE && service) {
      const { data } = await service.from("sports_access_requests").select("*").eq("id", reqId).maybeSingle();
      return (data as any) ?? null;
    }
    return (store.accessRequests.find(r => r.id === reqId) as any) ?? null;
  },

  async listRequestsForAthlete(athleteId: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_access_requests").select("*").eq("athlete_id", athleteId).order("created_at", { ascending: false });
      return data ?? [];
    }
    return store.accessRequests.filter(r => r.athlete_id === athleteId);
  },

  async auditForAthlete(athleteId: string) {
    if (LIVE && service) {
      const { data } = await service.from("sports_consent_audit").select("*").eq("athlete_id", athleteId).order("ts", { ascending: false });
      return data ?? [];
    }
    return store.audit.filter(a => a.athlete_id === athleteId);
  },
};
