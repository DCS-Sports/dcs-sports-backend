// src/mocks/store.ts
// Day-0 in-memory mock so consumers (CW10–CW16) get contract-valid JSON now.
// Mirrors the frozen S1 shapes. Replaced by real pg + RLS when DK provisions.
// This mock ENFORCES the same minor-safe Charter logic in code, so front-ends
// see correct behaviour before the DB is live. The DB RLS remains the source of
// truth in production — this is a faithful shadow, never the authority.

export const FROZEN_ROLES = [
  "athlete", "parent", "academy_admin", "coach", "scout",
  "league_admin", "association_admin", "franchise", "verifier", "admin",
] as const;
export type Role = (typeof FROZEN_ROLES)[number];

export interface User {
  id: string; email: string; phone?: string; name: string;
  dob?: string; role_flags: Role[]; created_at: string;
}
export interface Athlete {
  id: string; user_id: string; sport: string; role?: string;
  state?: string; district?: string; dob?: string;
  verified_status: "unverified" | "pending" | "verified";
  academy_id?: string | null;
  visibility: "private" | "academy" | "discoverable" | "public";
  created_at: string;
}
export interface Grant {
  id: string; athlete_id: string; grantee_id: string;
  scope: "profile" | "stats" | "media" | "full";
  granted_at: string; revoked_at?: string | null; expires_at?: string | null;
}
export interface ParentLink {
  parent_user_id: string; athlete_id: string;
  relation: "father" | "mother" | "guardian";
  consent: boolean; consented_at?: string | null;
}
export interface AccessRequest {
  id: string; athlete_id: string; requester_id: string;
  scope: "profile" | "stats" | "media" | "full"; reason?: string;
  status: "pending" | "approved" | "denied" | "withdrawn";
  decided_by?: string | null; decided_at?: string | null; created_at: string;
}
export interface AuditEntry {
  id: string; athlete_id?: string | null; actor_id?: string | null;
  action: string; scope?: string | null; subject_is_minor?: boolean;
  detail_json: Record<string, unknown>; ts: string;
}

function uid(p: string) { return `${p}-${Math.random().toString(16).slice(2, 10)}`; }
function isMinor(dob?: string): boolean {
  if (!dob) return false;
  const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 18);
  return new Date(dob) > cutoff;
}

class Store {
  users: User[] = [];
  athletes: Athlete[] = [];
  grants: Grant[] = [];
  parentLinks: ParentLink[] = [];
  accessRequests: AccessRequest[] = [];
  audit: AuditEntry[] = [];
  profiles: Record<string, any> = {};
  receipts: any[] = [];
  erasures: any[] = [];
  minorAccess: any[] = [];
  orgs: any[] = [];
  orgMembers: any[] = [];
  orgDelegationAudit: any[] = [];
  ownership: Record<string, any> = {};
  kyc: Record<string, any> = {};

  constructor() { this.seed(); }

  seed() {
    const now = new Date().toISOString();
    const adult: User = { id: "u-adult", email: "adult@demo.dcs", name: "Adult Athlete", dob: "1995-01-01", role_flags: ["athlete"], created_at: now };
    const minor: User = { id: "u-minor", email: "minor@demo.dcs", name: "Minor Athlete", dob: "2012-01-01", role_flags: ["athlete"], created_at: now };
    const scout: User = { id: "u-scout", email: "scout@demo.dcs", name: "Scout Sam", role_flags: ["scout"], created_at: now };
    const parent: User = { id: "u-parent", email: "parent@demo.dcs", name: "Parent Pat", role_flags: ["parent"], created_at: now };
    const admin: User = { id: "u-admin", email: "admin@demo.dcs", name: "Platform Admin", role_flags: ["admin", "verifier"], created_at: now };
    this.users.push(adult, minor, scout, parent, admin);
    this.athletes.push(
      { id: "a-adult", user_id: "u-adult", sport: "cricket", role: "batsman", dob: "1995-01-01", verified_status: "unverified", academy_id: null, visibility: "discoverable", created_at: now },
      { id: "a-minor", user_id: "u-minor", sport: "cricket", role: "bowler", dob: "2012-01-01", verified_status: "unverified", academy_id: null, visibility: "discoverable", created_at: now },
    );
    this.parentLinks.push({ parent_user_id: "u-parent", athlete_id: "a-minor", relation: "guardian", consent: true, consented_at: now });
  }

  userById(id: string | null) { return this.users.find(u => u.id === id) || null; }
  isStaff(id: string | null) {
    const u = this.userById(id);
    return !!u && (u.role_flags.includes("admin") || u.role_flags.includes("verifier"));
  }

  /** Faithful in-code shadow of the S3 Charter RLS (DB is source of truth). */
  canReadAthlete(a: Athlete, viewer: string | null): boolean {
    if (this.isStaff(viewer)) return true;
    if (a.user_id === viewer) return true;
    // linked parent with consent
    if (this.parentLinks.some(p => p.athlete_id === a.id && p.parent_user_id === viewer && p.consent)) return true;
    const minor = isMinor(a.dob);
    const hasGrant = this.grants.some(g => g.athlete_id === a.id && g.grantee_id === viewer && this.grantActive(g));
    if (a.visibility === "public" && (!minor || hasGrant)) return true;
    if (a.visibility === "discoverable" && viewer && (!minor || hasGrant)) return true;
    return false;
  }

  addGrant(athlete_id: string, grantee_id: string, scope: Grant["scope"], expires_at?: string | null): Grant {
    const g: Grant = { id: uid("g"), athlete_id, grantee_id, scope, granted_at: new Date().toISOString(), revoked_at: null, expires_at: expires_at ?? null };
    this.grants.push(g); return g;
  }
  /** Mirror of sports_grant_is_active: not revoked AND not past expiry. */
  grantActive(g: Grant): boolean {
    return !g.revoked_at && (!g.expires_at || new Date(g.expires_at) > new Date());
  }
  revokeGrant(id: string): boolean {
    const g = this.grants.find(x => x.id === id);
    if (!g) return false; g.revoked_at = new Date().toISOString(); return true;
  }

  /** Extend (or set) a grant's expiry without breaking the audit chain. */
  renewGrant(id: string, newExpiry: string | null): Grant | null {
    const g = this.grants.find(x => x.id === id);
    if (!g) return null;
    g.expires_at = newExpiry;
    if (g.revoked_at && (!newExpiry || new Date(newExpiry) > new Date())) g.revoked_at = null; // reactivate if extended
    return g;
  }

  /** All athlete ids whose consent this user controls (owns as adult, or consented parent). */
  athletesControlledBy(uid: string | null): string[] {
    if (!uid) return [];
    const owned = this.athletes.filter(a => a.user_id === uid).map(a => a.id);
    const asParent = this.parentLinks.filter(p => p.parent_user_id === uid && p.consent).map(p => p.athlete_id);
    return Array.from(new Set([...owned, ...asParent]));
  }

  /** Active grants across all athletes a user controls (for the bulk console). */
  activeGrantsControlledBy(uid: string | null): Grant[] {
    const ids = new Set(this.athletesControlledBy(uid));
    return this.grants.filter(g => ids.has(g.athlete_id) && this.grantActive(g));
  }

  /** Grants expiring within `days` (active, not yet lapsed) for a controller. */
  grantsExpiringSoon(uid: string | null, days: number): Grant[] {
    const ids = new Set(this.athletesControlledBy(uid));
    const now = Date.now(); const horizon = now + days * 86400000;
    return this.grants.filter(g =>
      ids.has(g.athlete_id) && this.grantActive(g) && g.expires_at &&
      new Date(g.expires_at).getTime() <= horizon && new Date(g.expires_at).getTime() > now);
  }

  athleteById(id: string) { return this.athletes.find(a => a.id === id) || null; }

  /** Shadow of sports_can_approve_for: who may approve/grant for this athlete. */
  canApproveFor(athleteId: string, actor: string | null): boolean {
    if (this.isStaff(actor)) return true;
    const a = this.athleteById(athleteId);
    if (!a || !actor) return false;
    if (!isMinor(a.dob)) return a.user_id === actor;            // adult: the athlete
    return this.parentLinks.some(p =>                            // minor: consented parent
      p.athlete_id === athleteId && p.parent_user_id === actor && p.consent);
  }

  logAudit(e: Omit<AuditEntry, "id" | "ts">) {
    this.audit.push({ id: uid("au"), ts: new Date().toISOString(), ...e });
  }

  createRequest(athlete_id: string, requester_id: string, scope: AccessRequest["scope"], reason?: string): AccessRequest | { error: string } {
    if (this.accessRequests.some(r => r.athlete_id === athlete_id && r.requester_id === requester_id && r.scope === scope && r.status === "pending"))
      return { error: "a pending request for this scope already exists" };
    const r: AccessRequest = { id: uid("req"), athlete_id, requester_id, scope, reason, status: "pending", created_at: new Date().toISOString() };
    this.accessRequests.push(r);
    const a = this.athleteById(athlete_id);
    this.logAudit({ athlete_id, actor_id: requester_id, action: "request_created", scope, subject_is_minor: isMinor(a?.dob), detail_json: { reason } });
    return r;
  }

  /** Approve a request: only an authorized approver; on approve, also mints the grant. */
  decideRequest(reqId: string, actor: string | null, decision: "approved" | "denied", expiresAt?: string | null): { ok: boolean; reason?: string; grant?: Grant } {
    const r = this.accessRequests.find(x => x.id === reqId);
    if (!r) return { ok: false, reason: "not found" };
    if (r.status !== "pending") return { ok: false, reason: `request is ${r.status}` };
    if (!this.canApproveFor(r.athlete_id, actor))
      return { ok: false, reason: "not authorized to decide (minor requires a consented parent)" };
    r.status = decision; r.decided_by = actor; r.decided_at = new Date().toISOString();
    const a = this.athleteById(r.athlete_id);
    this.logAudit({ athlete_id: r.athlete_id, actor_id: actor, action: decision === "approved" ? "request_approved" : "request_denied", scope: r.scope, subject_is_minor: isMinor(a?.dob), detail_json: {} });
    if (decision === "approved") {
      const g = this.addGrant(r.athlete_id, r.requester_id, r.scope, expiresAt ?? null);
      this.logAudit({ athlete_id: r.athlete_id, actor_id: actor, action: "grant_created", scope: r.scope, subject_is_minor: isMinor(a?.dob), detail_json: { from_request: reqId } });
      return { ok: true, grant: g };
    }
    return { ok: true };
  }

  /** Requester withdraws their own pending request. */
  withdrawRequest(reqId: string, actor: string | null): boolean {
    const r = this.accessRequests.find(x => x.id === reqId);
    if (!r || r.requester_id !== actor || r.status !== "pending") return false;
    r.status = "withdrawn";
    this.logAudit({ athlete_id: r.athlete_id, actor_id: actor, action: "request_withdrawn", scope: r.scope, detail_json: {} });
    return true;
  }
}

export const store = new Store();
export { isMinor };
