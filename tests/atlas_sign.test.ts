// tests/atlas_sign.test.ts
import { generateKeyPairSync } from 'crypto';
import { issueReceipt, verifyReceiptSig } from '../src/routes/atlas_sign';

describe('ed25519 verification receipts (Atlas interface)', () => {
  beforeAll(() => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    process.env.SPORTS_ED25519_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SPORTS_ED25519_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });

  it('signs and verifies a receipt', () => {
    const r = issueReceipt({
      subject_type: 'athlete',
      subject_id: 'ATH-1',
      attestation: 'human_verified',
      attested_by: 'verifier-7',
    });
    expect(r.sig).toBeTruthy();
    expect(r.receipt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyReceiptSig(r)).toBe(true);
  });

  it('detects a tampered attestation', () => {
    const r = issueReceipt({ subject_type: 'academy', subject_id: 'AC-1', attestation: 'human_verified', attested_by: 'v1' });
    const tampered = { ...r, attestation: 'forged' };
    expect(verifyReceiptSig(tampered)).toBe(false);
  });

  it('fails closed when signing key is unset', () => {
    const saved = process.env.SPORTS_ED25519_PRIVATE_KEY;
    delete process.env.SPORTS_ED25519_PRIVATE_KEY;
    expect(() => issueReceipt({ subject_type: 'coach', subject_id: 'C1', attestation: 'human_verified', attested_by: 'v' })).toThrow(/not set/);
    process.env.SPORTS_ED25519_PRIVATE_KEY = saved;
  });
});
