// CW13 — Verification Authority service (module 4.4).
// State machine: pending -> (ai_passed) -> human_verified | rejected.
// HARD RULE (honest-scope): a badge ("verified" / blue tick) only exists at
// status=human_verified, which REQUIRES a human verifier action AND a real
// ed25519 sig from Atlas. Nothing here can auto-promote to human_verified.
//
// Persistence is via verification-repo (live Supabase service-role, mock fallback).

import { randomUUID } from 'node:crypto';
import type { EntityType, VerificationRow } from '../lib/contracts';
import { issueReceipt, verifyReceiptSig } from '../lib/atlas-sign';
import { encodeReceipt, decodeReceipt, chainTip, buildChain, effectiveBadge, type ChainReport } from '../lib/receipt-chain';
import {
  runVerificationAgent,
  type AnomalySignal,
  type AnomalyAssessment,
} from './verification-agent';
import {
  insertVerification,
  getVerification,
  updateVerification,
  listQueue,
  listByEntity,
} from './verification-repo';

export async function submitVerification(
  entityType: EntityType,
  entityId: string,
  evidenceUrl: string | null
): Promise<VerificationRow> {
  const row: VerificationRow = {
    id: randomUUID(),
    entity_type: entityType,
    entity_id: entityId,
    status: 'pending',
    verified_by: null,
    evidence_url: evidenceUrl,
    ts: new Date().toISOString(),
    sig: null,
  };
  return insertVerification(row);
}

// AI pre-check — runs the Verification AI agent (heuristic anomaly assessment),
// records a high-stakes suggestion for a human, and advances to ai_passed ONLY
// when not flagged. A flagged check STAYS pending and surfaces the reasons to
// the verifier — the agent never clears its own flag (80/20 human sign-off).
export async function markAiPassed(
  id: string,
  signal?: AnomalySignal
): Promise<{ row: VerificationRow; assessment: AnomalyAssessment }> {
  const row = await getVerification(id);
  if (row.status !== 'pending') {
    throw new Error(`INVALID_TRANSITION: ${row.status} -> ai_passed`);
  }
  const effectiveSignal: AnomalySignal = signal ?? { has_evidence: row.evidence_url != null };
  const { assessment } = await runVerificationAgent(id, row.entity_type, effectiveSignal);

  if (assessment.flagged) {
    // stays pending; the flag is now on record for the human verifier
    return { row, assessment };
  }
  const updated = await updateVerification(id, { status: 'ai_passed' });
  return { row: updated, assessment };
}

// Human-in-the-loop gate. Requires a verifier user_id. Writes the ed25519
// receipt sig — if Atlas is not wired, issueReceipt throws and the badge does
// NOT issue (fail-closed). Optional validity window (validDays) sets expiry.
export async function approveVerification(
  id: string,
  verifierUserId: string,
  opts?: { validDays?: number }
): Promise<VerificationRow> {
  if (!verifierUserId) {
    throw new Error('HUMAN_REQUIRED: a verifier user_id is required to approve');
  }
  const row = await getVerification(id);
  if (row.status !== 'pending' && row.status !== 'ai_passed') {
    throw new Error(`INVALID_TRANSITION: ${row.status} -> human_verified`);
  }

  // Chain this receipt to the entity's previous receipt (tamper-evident audit
  // trail). prev_hash = the tip of the existing chain for this entity.
  const existing = await listByEntity(row.entity_type, row.entity_id);
  const prevHash = chainTip(existing);

  const expiresAt = opts?.validDays
    ? new Date(Date.now() + opts.validDays * 864e5).toISOString()
    : null;

  // sig FIRST — if Atlas isn't wired this throws and we never mutate the row.
  const receipt = await issueReceipt({
    subject_type: row.entity_type,
    subject_id: row.entity_id,
    attestation: 'verified',
    attested_by: verifierUserId,
    prev_hash: prevHash,
  });

  // Persist the full receipt envelope (sig + hashes + kind + expiry) in the S1
  // `sig` column — no new schema. Decodes back via decodeReceipt.
  return updateVerification(id, {
    status: 'human_verified',
    verified_by: verifierUserId,
    sig: encodeReceipt({
      sig: receipt.sig,
      receipt_hash: receipt.receipt_hash,
      prev_hash: receipt.prev_hash,
      kind: 'verify',
      expires_at: expiresAt,
    }),
    ts: new Date().toISOString(),
  });
}

// Revoke a live badge. Records a NEW signed `revoke` event chained to the
// entity's receipt history (status 'rejected' on-contract — no new enum value).
// Honest-scope: revocation is a human action, fail-closed if Atlas unwired, and
// the revocation itself is an ed25519 receipt appended to the provable chain.
export async function revokeVerification(
  entityType: EntityType,
  entityId: string,
  verifierUserId: string,
  reason: string
): Promise<VerificationRow> {
  if (!verifierUserId) throw new Error('HUMAN_REQUIRED: a verifier user_id is required to revoke');
  const existing = await listByEntity(entityType, entityId);
  const live = effectiveBadge(existing);
  if (!live.verified) {
    throw new Error('NOT_VERIFIED: no live badge to revoke for ' + entityType + ' ' + entityId);
  }
  const prevHash = chainTip(existing);

  // sig FIRST — fail-closed if Atlas unwired (no fabricated revocation).
  const receipt = await issueReceipt({
    subject_type: entityType,
    subject_id: entityId,
    attestation: 'revoked',
    attested_by: verifierUserId,
    prev_hash: prevHash,
  });

  const revRow: VerificationRow = {
    id: randomUUID(),
    entity_type: entityType,
    entity_id: entityId,
    status: 'rejected', // on-contract: 'revoked' is not in the S1 enum
    verified_by: verifierUserId,
    evidence_url: null,
    ts: new Date().toISOString(),
    sig: encodeReceipt({
      sig: receipt.sig,
      receipt_hash: receipt.receipt_hash,
      prev_hash: receipt.prev_hash,
      kind: 'revoke',
      expires_at: null,
    }),
  };
  return insertVerification(revRow);
}

export async function rejectVerification(
  id: string,
  verifierUserId: string,
  _reason?: string
): Promise<VerificationRow> {
  const row = await getVerification(id);
  if (row.status === 'human_verified') {
    throw new Error('INVALID_TRANSITION: human_verified -> rejected (already badged)');
  }
  return updateVerification(id, {
    status: 'rejected',
    verified_by: verifierUserId,
    ts: new Date().toISOString(),
  });
}

export async function getStatus(id: string): Promise<VerificationRow> {
  return getVerification(id);
}

export async function reviewQueue(status?: VerificationRow['status']): Promise<VerificationRow[]> {
  return listQueue(status);
}

export interface PublicBadge {
  entity_type: EntityType;
  entity_id: string;
  verified: boolean;          // true only for a live (non-revoked, non-expired) badge
  verified_at: string | null;
  expires_at: string | null;
  reason: 'none' | 'verified' | 'revoked' | 'expired';
  sig: string | null;         // ed25519 receipt sig — provable "blue tick"
}

// Public badge = the EFFECTIVE state: latest signed verify event that isn't
// revoked or expired. Computed over the full row set (service role) so a
// revoked/expired badge correctly reads unverified — RLS alone can't see the
// revoke row (it's status 'rejected', hidden from anon). Only the safe public
// projection is returned.
export async function publicBadge(entityType: EntityType, entityId: string): Promise<PublicBadge> {
  const rows = await listByEntity(entityType, entityId);
  const eff = effectiveBadge(rows);
  return {
    entity_type: entityType,
    entity_id: entityId,
    verified: eff.verified,
    verified_at: eff.verified_at,
    expires_at: eff.expires_at,
    reason: eff.reason,
    sig: eff.sig,
  };
}

// Verifier-facing audit trail: the full hash-chained receipt history for an
// entity, with linkage integrity + per-link signature validity. This is the
// "provable" view — a verifier can confirm the chain is intact and every
// receipt is genuinely Atlas-signed.
export interface AuditChain extends ChainReport {
  sigs_valid: boolean;        // every link's ed25519 sig verifies (false if Atlas unwired)
  invalid_sig_at: number | null;
}

export async function getChain(entityType: EntityType, entityId: string): Promise<AuditChain> {
  const rows = await listByEntity(entityType, entityId);
  const report = buildChain(entityType, entityId, rows);

  let sigs_valid = report.links.length > 0;
  let invalid_sig_at: number | null = null;
  for (let i = 0; i < report.links.length; i++) {
    const link = report.links[i];
    const ok = link.sig && link.receipt_hash
      ? await verifyReceiptSig({
          subject_type: entityType,
          subject_id: entityId,
          // attestation matches how the receipt was signed (verify vs revoke)
          attestation: link.kind === 'revoke' ? 'revoked' : 'verified',
          attested_by: link.verified_by ?? '',
          prev_hash: link.prev_hash,
          receipt_hash: link.receipt_hash,
          sig: link.sig,
        })
      : false;
    if (!ok) {
      sigs_valid = false;
      invalid_sig_at = i;
      break;
    }
  }
  return { ...report, sigs_valid, invalid_sig_at };
}

// Public-safe view of the proof chain: confirms the badge is real + provable
// WITHOUT exposing verifier identities or internal ids. For the public verify
// page — "the blue tick is provable, not cosmetic" — minus PII.
export interface PublicProof {
  entity_type: EntityType;
  entity_id: string;
  verified: boolean;          // effective state (revoked/expired => false)
  reason: 'none' | 'verified' | 'revoked' | 'expired';
  verified_at: string | null;
  expires_at: string | null;
  sig: string | null;         // the live badge's ed25519 sig
  proof: {
    events: number;           // chain length (verify + revoke events)
    intact: boolean;          // hash linkage holds
    signatures_valid: boolean;// every receipt signature verifies
    timeline: { kind: 'verify' | 'revoke'; at: string }[]; // ts + kind only, no ids
  };
}

export async function publicProof(entityType: EntityType, entityId: string): Promise<PublicProof> {
  const badge = await publicBadge(entityType, entityId);
  const chain = await getChain(entityType, entityId);
  return {
    entity_type: entityType,
    entity_id: entityId,
    verified: badge.verified,
    reason: badge.reason,
    verified_at: badge.verified_at,
    expires_at: badge.expires_at,
    sig: badge.sig,
    proof: {
      events: chain.links.length,
      intact: chain.intact,
      signatures_valid: chain.sigs_valid,
      timeline: chain.links.map((l) => ({ kind: l.kind, at: l.ts })),
    },
  };
}

export interface VerifierMetrics {
  by_status: Record<string, number>;
  by_entity_type: Record<string, number>;
  queue_depth: number;        // pending + ai_passed awaiting human action
  live_badges: number;        // distinct entities with an effective live badge
  total: number;
}

// Admin-dashboard metrics. Verifier/admin only (gated upstream).
export async function verifierMetrics(): Promise<VerifierMetrics> {
  const rows = await listQueue();
  const by_status: Record<string, number> = {};
  const by_entity_type: Record<string, number> = {};
  for (const r of rows) {
    by_status[r.status] = (by_status[r.status] ?? 0) + 1;
    by_entity_type[r.entity_type] = (by_entity_type[r.entity_type] ?? 0) + 1;
  }
  const queue_depth = (by_status['pending'] ?? 0) + (by_status['ai_passed'] ?? 0);

  // live badges: group by entity, count those whose effective state is verified
  const byEntity = new Map<string, VerificationRow[]>();
  for (const r of rows) {
    const k = r.entity_type + ':' + r.entity_id;
    const arr = byEntity.get(k) ?? [];
    arr.push(r);
    byEntity.set(k, arr);
  }
  let live_badges = 0;
  for (const arr of byEntity.values()) {
    if (effectiveBadge(arr).verified) live_badges++;
  }

  return { by_status, by_entity_type, queue_depth, live_badges, total: rows.length };
}
