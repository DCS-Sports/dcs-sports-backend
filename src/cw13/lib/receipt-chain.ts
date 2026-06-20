// CW13 — verification receipt chain (provable audit trail).
// Each verification event issues an ed25519 receipt chained to the previous
// receipt for the SAME entity via prev_hash -> tamper-evident history.
//
// SCHEMA-HONEST: S1 gives one free-text column on sports_verifications — `sig`
// ("the ed25519 receipt sig"). We persist the FULL receipt envelope there as a
// versioned, self-describing string instead of inventing new columns:
//     r2:<base64url(JSON{ sig, receipt_hash, prev_hash, kind, expires_at })>
// Backward-compatible: r1:<...> (no kind/expiry) and a bare legacy sig both
// still decode. No migration, no DK schema sign-off needed.

import type { Receipt, VerificationRow } from './contracts';

export type ReceiptKind = 'verify' | 'revoke';

export interface DecodedReceipt {
  sig: string;
  receipt_hash: string | null;
  prev_hash: string | null;
  kind: ReceiptKind;
  expires_at: string | null;
}

const PREFIX2 = 'r2:';
const PREFIX1 = 'r1:';

export function encodeReceipt(r: {
  sig: string;
  receipt_hash: string;
  prev_hash: string | null;
  kind?: ReceiptKind;
  expires_at?: string | null;
}): string {
  const json = JSON.stringify({
    sig: r.sig,
    receipt_hash: r.receipt_hash,
    prev_hash: r.prev_hash,
    kind: r.kind ?? 'verify',
    expires_at: r.expires_at ?? null,
  });
  return PREFIX2 + Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeReceipt(stored: string | null): DecodedReceipt | null {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX2) && !stored.startsWith(PREFIX1)) {
    // legacy bare sig
    return { sig: stored, receipt_hash: null, prev_hash: null, kind: 'verify', expires_at: null };
  }
  const prefix = stored.startsWith(PREFIX2) ? PREFIX2 : PREFIX1;
  try {
    const json = Buffer.from(stored.slice(prefix.length), 'base64url').toString('utf8');
    const o = JSON.parse(json) as Partial<DecodedReceipt>;
    return {
      sig: o.sig as string,
      receipt_hash: o.receipt_hash ?? null,
      prev_hash: o.prev_hash ?? null,
      kind: (o.kind as ReceiptKind) ?? 'verify',
      expires_at: o.expires_at ?? null,
    };
  } catch {
    return null;
  }
}

// Pull the most recent receipt_hash for an entity's chain (the tip), to use as
// the next receipt's prev_hash. Includes ALL signed rows (verify + revoke) so
// the chain stays continuous across revocations.
export function chainTip(rows: VerificationRow[]): string | null {
  const signed = rows
    .filter((r) => r.sig && decodeReceipt(r.sig)?.receipt_hash)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (signed.length === 0) return null;
  const last = decodeReceipt(signed[signed.length - 1].sig);
  return last?.receipt_hash ?? null;
}

export interface ChainLink {
  verification_id: string;
  ts: string;
  status: VerificationRow['status'];
  verified_by: string | null;
  receipt_hash: string | null;
  prev_hash: string | null;
  sig: string | null;
  kind: ReceiptKind;
  expires_at: string | null;
}

export interface ChainReport {
  entity_type: string;
  entity_id: string;
  links: ChainLink[];
  intact: boolean;            // every link's prev_hash matches the prior link's receipt_hash
  break_at: number | null;    // index of the first broken link, or null
}

// Build the ordered chain for an entity and check linkage integrity. Includes
// ALL signed events (verify + revoke) so the chain reflects the full lifecycle.
// Signature validity is checked separately via the Atlas verifier.
export function buildChain(entityType: string, entityId: string, rows: VerificationRow[]): ChainReport {
  const links: ChainLink[] = rows
    .filter((r) => r.entity_type === entityType && r.entity_id === entityId && r.sig && decodeReceipt(r.sig)?.receipt_hash)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((r) => {
      const d = decodeReceipt(r.sig)!;
      return {
        verification_id: r.id,
        ts: r.ts,
        status: r.status,
        verified_by: r.verified_by,
        receipt_hash: d.receipt_hash,
        prev_hash: d.prev_hash,
        sig: d.sig,
        kind: d.kind,
        expires_at: d.expires_at,
      };
    });

  let intact = true;
  let break_at: number | null = null;
  for (let i = 0; i < links.length; i++) {
    const expectedPrev = i === 0 ? null : links[i - 1].receipt_hash;
    if (links[i].prev_hash !== expectedPrev) {
      intact = false;
      break_at = i;
      break;
    }
  }
  return { entity_type: entityType, entity_id: entityId, links, intact, break_at };
}

export interface EffectiveBadge {
  verified: boolean;
  reason: 'none' | 'verified' | 'revoked' | 'expired';
  verified_at: string | null;
  expires_at: string | null;
  sig: string | null;
}

// The live-badge rule from the full row set: the latest signed `verify` event
// that is (a) not superseded by a later `revoke` and (b) not past expiry.
export function effectiveBadge(rows: VerificationRow[], now: Date = new Date()): EffectiveBadge {
  const signed = rows
    .filter((r) => r.sig && decodeReceipt(r.sig)?.receipt_hash)
    .map((r) => ({ row: r, d: decodeReceipt(r.sig)! }))
    .sort((a, b) => a.row.ts.localeCompare(b.row.ts));

  // walk newest-first to find the controlling event
  for (let i = signed.length - 1; i >= 0; i--) {
    const { row, d } = signed[i];
    if (d.kind === 'revoke') {
      return { verified: false, reason: 'revoked', verified_at: null, expires_at: null, sig: null };
    }
    // d.kind === 'verify'
    if (d.expires_at && new Date(d.expires_at).getTime() < now.getTime()) {
      return { verified: false, reason: 'expired', verified_at: row.ts, expires_at: d.expires_at, sig: null };
    }
    return { verified: true, reason: 'verified', verified_at: row.ts, expires_at: d.expires_at, sig: d.sig };
  }
  return { verified: false, reason: 'none', verified_at: null, expires_at: null, sig: null };
}
