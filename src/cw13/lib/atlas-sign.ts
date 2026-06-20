// CW13 — Atlas ed25519 adapter.
// REUSE, do not rebuild: the canonical implementation is Atlas's atlas-sign.ts
// (verify.dcslabs.ai). This module exposes the frozen S4 interface
// (issueReceipt / verifyReceiptSig) with the canonical sorted-key payload, and
// delegates the actual sign/verify to the Atlas signer when wired in.
//
// Day-0 posture: the Atlas signer is injected. Until DK/ops wire the real
// Atlas key, the injected signer is a fail-closed placeholder that produces a
// clearly-marked unsigned receipt (sig = null path) so we NEVER fabricate a
// cryptographic signature. The crypto gate is honest: no real sig, no badge.

import type { Receipt, ReceiptInput } from './contracts';

// The shape Atlas's signer must satisfy. When wired, point this at atlas-sign.ts.
export interface AtlasSigner {
  sign(canonicalPayload: string): Promise<string> | string; // -> base64 ed25519 sig
  verify(canonicalPayload: string, sig: string): Promise<boolean> | boolean;
  hash(canonicalPayload: string): Promise<string> | string;  // -> receipt_hash
}

// Canonical sorted-key JSON of the EXACT frozen field set (S4):
// { attestation, attested_by, prev_hash, subject_id, subject_type }
export function canonicalPayload(input: ReceiptInput): string {
  const ordered = {
    attestation: input.attestation,
    attested_by: input.attested_by,
    prev_hash: input.prev_hash,
    subject_id: input.subject_id,
    subject_type: input.subject_type,
  };
  // sorted keys (already in order) + stable stringify
  return JSON.stringify(ordered, Object.keys(ordered).sort());
}

let _signer: AtlasSigner | null = null;

export function wireAtlasSigner(signer: AtlasSigner): void {
  _signer = signer;
}

export function isAtlasWired(): boolean {
  return _signer !== null;
}

export async function issueReceipt(input: ReceiptInput): Promise<Receipt> {
  if (!_signer) {
    // Fail-closed: no real Atlas key in-session. Do not fabricate a sig.
    throw new Error(
      'ATLAS_NOT_WIRED: ed25519 signer unavailable — reuse Atlas atlas-sign.ts. ' +
        'Verification cannot reach human_verified without a real sig. (honest-scope: no fabricated crypto)'
    );
  }
  const payload = canonicalPayload(input);
  const receipt_hash = await _signer.hash(payload);
  const sig = await _signer.sign(payload);
  return { ...input, receipt_hash, sig };
}

export async function verifyReceiptSig(receipt: Receipt): Promise<boolean> {
  if (!_signer) return false; // fail-closed
  const payload = canonicalPayload(receipt);
  return _signer.verify(payload, receipt.sig);
}

// Sign an arbitrary payload string with the Atlas signer (e.g. an audit-export
// bundle digest). Fail-closed if the signer isn't wired.
export async function signRaw(payload: string): Promise<string> {
  if (!_signer) throw new Error('ATLAS_NOT_WIRED');
  return _signer.sign(payload);
}
