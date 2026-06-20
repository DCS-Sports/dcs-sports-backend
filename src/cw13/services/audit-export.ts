// CW13 — federation-grade audit export (v2.0).
// Produces a self-contained, downloadable bundle that a federation/regulator can
// verify OFFLINE against the DCS Labs ed25519 public key — WITHOUT trusting our
// server. The bundle contains, per receipt: the exact canonical payload that was
// signed, the signature, and the hash chain links. Plus a bundle-level signature
// over the whole export for tamper-evidence.
//
// HONEST-SCOPE: signatures are only real once Atlas is wired. The export is
// structurally correct regardless; the independent verifier (tools/verify-export)
// checks whatever signer produced the receipts. If Atlas is unwired there are no
// signed receipts to export (fail-closed upstream), so an export is either empty
// or contains genuinely-signed receipts — never fabricated ones.

import { listByEntity } from './verification-repo';
import { buildChain } from '../lib/receipt-chain';
import { canonicalPayload, signRaw, isAtlasWired } from '../lib/atlas-sign';
import type { EntityType } from '../lib/contracts';

export interface ExportReceipt {
  index: number;
  kind: 'verify' | 'revoke';
  ts: string;
  // the EXACT canonical (sorted-key) payload that was signed — recompute + verify
  canonical_payload: string;
  receipt_hash: string | null;
  prev_hash: string | null;
  sig: string | null;
  expires_at: string | null;
}

export interface AuditExport {
  format: 'dcs-sports-audit-export/v1';
  issued_at: string;
  subject: { entity_type: EntityType; entity_id: string };
  attested_by_note: string; // explains attested_by is redacted in canonical? (see below)
  chain: { intact: boolean; break_at: number | null; event_count: number };
  receipts: ExportReceipt[];
  // bundle-level signature over a canonical digest of {subject, receipts} so the
  // whole export is tamper-evident. Present only when Atlas is wired.
  bundle: { digest_payload: string; sig: string | null; atlas_wired: boolean };
}

// Build the export. attested_by IS part of the canonical payload (it's what was
// signed), so the canonical_payload necessarily contains the verifier id — this
// export is the FEDERATION-grade artifact (regulator-facing), distinct from the
// public PII-redacted /verify-public. Access is verifier/admin/federation only.
export async function auditExport(entityType: EntityType, entityId: string): Promise<AuditExport> {
  const rows = await listByEntity(entityType, entityId);
  const chain = buildChain(entityType, entityId, rows);

  const receipts: ExportReceipt[] = chain.links.map((l, i) => ({
    index: i,
    kind: l.kind,
    ts: l.ts,
    canonical_payload: canonicalPayload({
      subject_type: entityType,
      subject_id: entityId,
      attestation: l.kind === 'revoke' ? 'revoked' : 'verified',
      attested_by: l.verified_by ?? '',
      prev_hash: l.prev_hash,
    }),
    receipt_hash: l.receipt_hash,
    prev_hash: l.prev_hash,
    sig: l.sig,
    expires_at: l.expires_at,
  }));

  // bundle digest = canonical JSON of the subject + ordered receipt sigs/hashes.
  const digestPayload = JSON.stringify({
    subject: { entity_type: entityType, entity_id: entityId },
    receipts: receipts.map((r) => ({ h: r.receipt_hash, p: r.prev_hash, s: r.sig })),
  });

  let bundleSig: string | null = null;
  if (isAtlasWired() && receipts.length > 0) {
    // sign the digest_payload DIRECTLY with the Atlas signer so an independent
    // verifier checks bundle.sig over exactly digest_payload.
    try {
      bundleSig = await signRaw(digestPayload);
    } catch {
      bundleSig = null; // fail-closed; per-receipt verify still works
    }
  }

  return {
    format: 'dcs-sports-audit-export/v1',
    issued_at: new Date().toISOString(),
    subject: { entity_type: entityType, entity_id: entityId },
    attested_by_note:
      'canonical_payload includes attested_by (the verifier id) — this is the federation-grade artifact. For a public, PII-redacted view use /verify-public.',
    chain: { intact: chain.intact, break_at: chain.break_at, event_count: chain.links.length },
    receipts,
    bundle: { digest_payload: digestPayload, sig: bundleSig, atlas_wired: isAtlasWired() },
  };
}
