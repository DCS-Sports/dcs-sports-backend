// src/routes/atlas_sign.ts
// ed25519 verification receipts — reuse the Atlas interface (#7). Canonical
// sorted-key JSON body; issueReceipt / verifyReceiptSig. Node crypto, no new
// crypto build. Key from env (CW13/DK provisions); fails closed if absent.
import { createPrivateKey, createPublicKey, sign, verify, createHash, KeyObject } from 'crypto';

export interface ReceiptInput {
  subject_type: string;
  subject_id: string;
  attestation: string;
  attested_by: string;
  prev_hash?: string | null;
}

export interface Receipt extends ReceiptInput {
  prev_hash: string | null;
  receipt_hash: string;
  sig: string; // base64
}

/** Canonical signed body: sorted-key JSON of the five fields (Atlas contract). */
function canonicalBody(i: ReceiptInput): string {
  const ordered = {
    attestation: i.attestation,
    attested_by: i.attested_by,
    prev_hash: i.prev_hash ?? null,
    subject_id: i.subject_id,
    subject_type: i.subject_type,
  };
  return JSON.stringify(ordered);
}

function privKey(): KeyObject {
  const pem = process.env.SPORTS_ED25519_PRIVATE_KEY;
  if (!pem) throw new Error('[atlas-sign] SPORTS_ED25519_PRIVATE_KEY not set — verification signing unconfigured.');
  return createPrivateKey(pem.replace(/\\n/g, '\n'));
}

export function issueReceipt(input: ReceiptInput): Receipt {
  const prev_hash = input.prev_hash ?? null;
  const body = canonicalBody({ ...input, prev_hash });
  const receipt_hash = createHash('sha256').update(body).digest('hex');
  const sig = sign(null, Buffer.from(body), privKey()).toString('base64');
  return { ...input, prev_hash, receipt_hash, sig };
}

export function verifyReceiptSig(receipt: Receipt): boolean {
  const pem = process.env.SPORTS_ED25519_PUBLIC_KEY;
  if (!pem) throw new Error('[atlas-sign] SPORTS_ED25519_PUBLIC_KEY not set.');
  const pub = createPublicKey(pem.replace(/\\n/g, '\n'));
  const body = canonicalBody(receipt);
  return verify(null, Buffer.from(body), pub, Buffer.from(receipt.sig, 'base64'));
}

export const __testing = { canonicalBody };
