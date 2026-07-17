/**
 * evidence-passport/passport.mjs — DCS Sports · Match Evidence Passport (CW6, 16 Jul 2026)
 *
 * WHAT THIS IS
 * Extends per-event receipts into a SELLABLE, VERIFIABLE match bundle: every reviewed
 * incident becomes a signed record in a per-match hash chain, and the whole match exports
 * as one signed passport for organizers / associations / broadcasters / dispute resolution.
 *
 * WORDING RULE (non-negotiable, appears in every rendered surface):
 *   The passport proves the record WAS NOT SILENTLY REWRITTEN (tamper-EVIDENT).
 *   It does NOT prove the decision was correct. Decisions are made by humans.
 *
 * NO NEW CRYPTO. The sole primitive is the frozen fleet module
 * (vendor/R2_receipt_module_HARDENED.mjs): ed25519 over a 5-key canonical set, V2-2
 * hardened (verify re-derives canonical from body). This file only decides WHAT goes in
 * the attestation and HOW records chain. DCS and TRD never mix — this product signs with
 * its OWN key id (DEFAULT_KEY_ID below); the private key arrives via RECEIPT_SK (Railway,
 * DK only). With RECEIPT_SK unset the primitive falls back to an ephemeral per-process
 * key — fine for demo/tests, meaningless for production, and the bundle SAYS SO.
 *
 * THE REGISTRY IS NOT OPTIONAL. The primitive's verify() trusts the public key the
 * receipt carries — an attacker can mint a keypair and "verify". verifyPassport() here
 * therefore REQUIRES a registry (keyId → base64 SPKI pub) and rejects any receipt whose
 * embedded pub is not the registered one. There is no unregistered mode.
 *
 * INTEGRATION STATUS: STAGED, NOT WIRED. The gateway repo was not in the upload
 * (CW-C rule: ask, don't invent — this product is where that rule was learned).
 * handler.mjs exposes a pure function; wiring is ONE route line once the repo arrives.
 */
import { createHash } from 'node:crypto';
import { emit, verify, verifyChain } from './vendor/R2_receipt_module_HARDENED.mjs';

export const DEFAULT_KEY_ID = 'dcs-sports-evidence-key-2026';
export const SUBJECT_INCIDENT = 'sports_match_incident';
export const SUBJECT_PASSPORT = 'sports_evidence_passport';

export const WORDING = {
  claim: 'This passport proves the match record was not silently rewritten (tamper-evident).',
  nonClaim: 'It does NOT prove any decision was correct. All final decisions were made by humans.',
  estimate: 'All model outputs are estimates and are labelled as such.',
};

/** The per-incident fields the dispatch names, exactly. Everything is inside the SIGNED
 *  attestation — change any field after signing and verification fails. */
const INCIDENT_FIELDS = [
  'matchId', 'deliveryId', 'overBall',
  'sourceCameraIds',            // string[]
  'mediaHashes',                // { cameraId, sha256 }[]
  'audioHash',                  // sha256 | null
  'calibrationVersion',         // string | null (null until CW4's engine reports)
  'modelVersion',               // string | null
  'confidence',                 // number|null — an ESTIMATE, never a verdict
  'framesUsed',                 // { cameraId, from, to }[] | null
  'onFieldCall',                // what the on-field official originally called
  'reviewReason',               // why this was reviewed (feeds CW1's "Why was this reviewed?")
  'evidenceLabel',              // e.g. 'boundary-camera estimate' — CW3 fusion states land here
  'reviewer',                   // human identity/role — decisions are HUMAN
  'decision',                   // 'confirmed' | 'rejected'
  'corrections',                // { field, from, to, by, at }[] — visible, never silent
  'decidedAt',                  // ISO timestamp
];

/** Stable stringify: sorted keys, recursively — the attestation must canonicalise
 *  identically on every runtime or verification breaks across services. */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function pickIncident(raw) {
  const out = {};
  for (const f of INCIDENT_FIELDS) out[f] = raw[f] ?? null;
  if (out.decision !== 'confirmed' && out.decision !== 'rejected') {
    throw new Error(`incident ${out.matchId}:${out.deliveryId}: decision must be 'confirmed' or 'rejected' (a passport records HUMAN decisions, got ${JSON.stringify(raw.decision)})`);
  }
  if (!out.reviewer) throw new Error('incident without a reviewer — decisions are made by humans, and the passport names them');
  return out;
}

/** One reviewed incident → one signed, chained receipt. prevHash links per match. */
export function buildIncidentReceipt(incident, prevHash, keyId = DEFAULT_KEY_ID) {
  const record = pickIncident(incident);
  return emit({
    attestation: stableStringify(record),
    attested_by: keyId,
    prev_hash: prevHash ?? null,
    subject_id: `${record.matchId}:${record.deliveryId}`,
    subject_type: SUBJECT_INCIDENT,
  });
}

/**
 * The whole match → one bundle:
 *   incidents chained in decidedAt order, then a TERMINAL receipt whose attestation is a
 *   manifest (count + every receipt_hash + match summary hash), chained onto the same
 *   lineage — so removing, reordering, or editing ANY incident breaks verification of
 *   the bundle, not just of one record.
 */
export function buildPassportBundle({ match, incidents, keyId = DEFAULT_KEY_ID }) {
  if (!match?.matchId) throw new Error('match.matchId required');
  const ordered = [...incidents].sort((a, b) => String(a.decidedAt).localeCompare(String(b.decidedAt)));
  const chain = [];
  let prev = null;
  for (const inc of ordered) {
    const r = buildIncidentReceipt({ ...inc, matchId: match.matchId }, prev, keyId);
    chain.push(r);
    prev = r.receipt_hash;
  }
  const manifest = {
    matchId: match.matchId,
    matchSummarySha256: createHash('sha256').update(stableStringify(match)).digest('hex'),
    incidentCount: chain.length,
    incidentReceiptHashes: chain.map(r => r.receipt_hash),
    generatedAt: new Date().toISOString(),
    wording: WORDING,
    productionKey: !!process.env.RECEIPT_SK,   // honest: an ephemeral demo key is SAID to be one
  };
  const terminal = emit({
    attestation: stableStringify(manifest),
    attested_by: keyId,
    prev_hash: prev,
    subject_id: match.matchId,
    subject_type: SUBJECT_PASSPORT,
  });
  return { version: 'evidence-passport/1', keyId, match, manifest, incidents: chain, terminal };
}

/**
 * REGISTRY-CHECKED verification. `registry` maps keyId → base64 SPKI public key.
 * Rejects (with a reason) — never a bare boolean false without a why.
 */
export function verifyPassport(bundle, registry) {
  const fail = (reason) => ({ ok: false, reason });
  if (!registry || typeof registry !== 'object') return fail('no key registry supplied — refusing to verify against embedded keys');
  const expectedPub = registry[bundle?.keyId];
  if (!expectedPub) return fail(`key id ${bundle?.keyId} is not in the registry`);

  const all = [...(bundle.incidents ?? []), bundle.terminal].filter(Boolean);
  for (const r of all) {
    if (r.body?.attested_by !== bundle.keyId) return fail(`receipt ${r.receipt_hash} attested_by ${r.body?.attested_by} ≠ bundle key ${bundle.keyId}`);
    if (r.pub !== expectedPub) return fail(`receipt ${r.receipt_hash} carries a public key that is NOT the registered key for ${bundle.keyId} — attacker-minted keys verify raw, they do not verify HERE`);
    if (!verify(r)) return fail(`receipt ${r.receipt_hash} failed signature/canonical verification (record altered after signing)`);
  }
  if (!verifyChain(all)) return fail('hash lineage broken — an incident was removed, reordered, or inserted');

  const m = JSON.parse(bundle.terminal.body.attestation);
  if (m.incidentCount !== bundle.incidents.length) return fail(`manifest says ${m.incidentCount} incidents, bundle carries ${bundle.incidents.length}`);
  for (let i = 0; i < bundle.incidents.length; i++) {
    if (m.incidentReceiptHashes[i] !== bundle.incidents[i].receipt_hash) return fail(`incident ${i} hash ≠ manifest`);
  }
  const summaryHash = createHash('sha256').update(stableStringify(bundle.match)).digest('hex');
  if (summaryHash !== m.matchSummarySha256) return fail('match summary was edited after the passport was signed');
  return { ok: true, incidents: bundle.incidents.length, productionKey: m.productionKey === true };
}
