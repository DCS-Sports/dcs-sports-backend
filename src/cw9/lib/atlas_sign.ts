// src/lib/atlas_sign.ts
// CW9 consent receipts — atlas-sign-COMPATIBLE ed25519 (reuses the frozen S4
// interface; does NOT invent new crypto). A receipt signed here verifies
// identically to one signed by CW13's gateway, because the signed body is the
// SAME canonical sorted-key JSON of exactly {attestation, attested_by,
// prev_hash, subject_id, subject_type}.
//
// Keys: SPORTS_ED25519_PRIVATE / SPORTS_ED25519_PUBLIC (PEM or base64 PEM) in
// env, provisioned by DK (the SPORTS_ED25519_* item the manager flagged). If
// absent (offline/dev), an ephemeral keypair is generated so tests run and
// sign/verify round-trips, but receipts won't verify across restarts — prod
// MUST set the env keys (same key the gateway/CW13 uses).

import crypto from "node:crypto";

export interface ReceiptInput {
  subject_type: string;     // 'consent' | 'grant' | 'athlete' | ...
  subject_id: string;
  attestation: string;      // e.g. 'parent_consent_granted'
  attested_by: string;      // actor user id
  prev_hash: string | null; // hash-chain link (null = genesis for this subject)
}
export interface Receipt extends ReceiptInput {
  receipt_hash: string;     // sha256 of the canonical body
  sig: string;              // base64 ed25519 signature over the canonical body
  signed_at: string;        // iso (NOT part of the signed body — metadata)
}

/** Canonical sorted-key JSON over EXACTLY the 5 signed fields (matches CW13). */
export function canonicalBody(r: ReceiptInput): string {
  const ordered = {
    attestation: r.attestation,
    attested_by: r.attested_by,
    prev_hash: r.prev_hash,
    subject_id: r.subject_id,
    subject_type: r.subject_type,
  };
  // keys are already in sorted order; JSON.stringify with no spaces = canonical
  return JSON.stringify(ordered);
}

function loadKeys(): { priv: crypto.KeyObject; pub: crypto.KeyObject } {
  const privPem = process.env.SPORTS_ED25519_PRIVATE;
  const pubPem = process.env.SPORTS_ED25519_PUBLIC;
  if (privPem && pubPem) {
    const norm = (s: string) => (s.includes("BEGIN") ? s : Buffer.from(s, "base64").toString("utf8"));
    return {
      priv: crypto.createPrivateKey(norm(privPem)),
      pub: crypto.createPublicKey(norm(pubPem)),
    };
  }
  // offline/dev: ephemeral keypair (round-trips within a process)
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { priv: privateKey, pub: publicKey };
}
const KEYS = loadKeys();
export const keysFromEnv = Boolean(process.env.SPORTS_ED25519_PRIVATE && process.env.SPORTS_ED25519_PUBLIC);

/** issueReceipt — frozen S4 signature. */
export function issueReceipt(input: ReceiptInput): Receipt {
  const body = canonicalBody(input);
  const receipt_hash = crypto.createHash("sha256").update(body).digest("hex");
  const sig = crypto.sign(null, Buffer.from(body), KEYS.priv).toString("base64");
  return { ...input, receipt_hash, sig, signed_at: new Date().toISOString() };
}

/** verifyReceiptSig — recompute the canonical body, check hash + signature. */
export function verifyReceiptSig(r: Receipt): { ok: boolean; reason?: string } {
  const body = canonicalBody(r);
  const expectHash = crypto.createHash("sha256").update(body).digest("hex");
  if (expectHash !== r.receipt_hash) return { ok: false, reason: "hash mismatch (body altered)" };
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(body), KEYS.pub, Buffer.from(r.sig, "base64")); }
  catch { return { ok: false, reason: "signature malformed" }; }
  return ok ? { ok: true } : { ok: false, reason: "bad signature" };
}

/** Public key (base64 SPKI DER) so verifiers/CW13 can confirm the signer. */
export function publicKeyB64(): string {
  return KEYS.pub.export({ type: "spki", format: "der" }).toString("base64");
}
