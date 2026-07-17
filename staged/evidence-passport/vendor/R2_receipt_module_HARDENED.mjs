// Shared fleet R+2 receipt module — HARDENED for V2-2 (CW25 finding):
// verify() re-derives canonical FROM body and rejects any body≠canonical, so every consumer
// (Explorer, Replay, badges) is trustless-safe by default — it can never trust a forged `canonical`.
// ═══════════════════════════════════════════════════════════════════════════
// 🔑 KEY INJECTION — added 13 Jul 2026, on DK's explicit R-Series authorisation.
//
// WHY THIS CHANGE EXISTS
// `_kp ??= generateKeyPairSync("ed25519")` minted a NEW IDENTITY PER PROCESS. Every
// restart, every replica, a different signing key — and no setter, no env read, no
// way to supply a production key at all. So "signed receipts" could not be turned on
// by any amount of configuration. It was a missing capability, not a missing config.
//
// THE CHANGE IS PURELY ADDITIVE. With RECEIPT_SK unset, behaviour is byte-for-byte
// what it was: an ephemeral keypair. Explorer, Replay and the badges are unaffected.
// Nothing that does not set the env var can tell this changed.
//
// RECEIPT_SK = base64 of a PKCS8 DER ed25519 private key.  scripts/gen_receipt_key.mjs
//
// ⚠️ THIS ALONE DOES NOT MAKE A RECEIPT TRUSTWORTHY. verify() below still reads the
// public key OUT OF THE RECEIPT, so anyone can mint a keypair, sign a body, attach
// their own `pub`, and it verifies TRUE. That is a checksum, not a signature. The KEY
// REGISTRY that closes it lives in src/adapters/fleetReceipt.ts, which resolves
// `attested_by` to a registered public key and REJECTS any receipt whose embedded pub
// does not match. Do not ship signed receipts without it.
// ═══════════════════════════════════════════════════════════════════════════
import { generateKeyPairSync, sign, verify as edVerify, createHash, createPrivateKey, createPublicKey } from "node:crypto";
const KEYS=["attestation","attested_by","prev_hash","subject_id","subject_type"];
// The cache is keyed ON THE SECRET, not a bare `??=`. In production RECEIPT_SK never
// changes mid-process, so this is byte-for-byte the old behaviour. But a plain `??=`
// pins the FIRST key for the life of the process, which means a test that swaps
// RECEIPT_SK silently keeps signing with the previous key — and its assertions pass
// for the wrong reason. A signing key you cannot test is a signing key you cannot trust.
let _kp=null,_sk=Symbol("unset");
const kp=()=>{
  const sk = process.env.RECEIPT_SK ?? null;
  if (_kp && _sk === sk) return _kp;                          // same secret -> same identity
  _sk = sk;
  if (!sk) return (_kp = generateKeyPairSync("ed25519"));     // unchanged default: ephemeral
  const privateKey = createPrivateKey({ key: Buffer.from(sk, "base64"), format: "der", type: "pkcs8" });
  return (_kp = { privateKey, publicKey: createPublicKey(privateKey) });
};
export const canonical=b=>JSON.stringify(Object.fromEntries(KEYS.map(k=>[k,b?.[k]??null])));
export function emit(b){const c=canonical(b),sig=sign(null,Buffer.from(c),kp().privateKey).toString("base64");
 return{body:JSON.parse(c),canonical:c,sig,pub:kp().publicKey.export({type:"spki",format:"der"}).toString("base64"),
 receipt_hash:createHash("sha256").update(c+sig).digest("hex"),prev_hash:b.prev_hash??null,verified_by:"none",ts:new Date().toISOString()};}
export function verify(r){
 if(!r?.body||!r?.sig||!r?.pub) return false;
 const c=canonical(r.body);                              // ← re-derive from body (trustless)
 if(r.canonical!=null && r.canonical!==c) return false;  // ← body≠canonical → REJECT (V2-2)
 const ok=edVerify(null,Buffer.from(c),{key:Buffer.from(r.pub,"base64"),format:"der",type:"spki"},Buffer.from(r.sig,"base64"));
 const hashOk = r.receipt_hash==null || createHash("sha256").update(c+r.sig).digest("hex")===r.receipt_hash;
 return ok && hashOk;
}
export function verifyChain(rs){let p=null;for(const r of rs){if(!verify(r)||r.prev_hash!==p)return false;p=r.receipt_hash;}return true;}
