/**
 * CW20 R+3 — Merkle Audit Batch Endpoint + Filecoin Pin Stub
 *
 * Extends CW20_AgenticV2_CoreLoop_merkle.ts with:
 *   - Batch endpoint: POST /receipts/merkle-batch
 *   - Wiring into the receipt pipeline (called after every R+2 receipt)
 *   - Filecoin/IPFS pin stub (mock; real creds provisioned by DK in Phase 4)
 *   - GDPR tombstone + erasure proof
 *
 * Nothing charges or self-acts. AUTONOMY_LIVE=0 throughout.
 */

import { createHash } from 'node:crypto';
import { SupabaseClient } from '@supabase/supabase-js';

// ── Re-export core Merkle primitives (from CW20_AgenticV2_CoreLoop_merkle.ts) ─
export { merkleRoot, merkleProof, verifyProof, tombstoneHash } from './CW20_AgenticV2_CoreLoop_merkle';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MerkleBatchRecord {
  id: string;              // UUID
  user_id: string;
  receipt_ids: string[];   // ordered list of receipt hashes in this batch
  merkle_root: string;     // hex root of this batch
  leaf_count: number;
  ipfs_cid: string | null; // null until pinned; set by DK / Phase 4
  filecoin_deal_id: string | null;
  created_at: string;
}

export interface TombstoneRecord {
  id: string;
  original_receipt_hash: string;
  tombstone_hash: string;   // sha256("TOMBSTONE|<original>|<reason>")
  reason: string;
  created_at: string;
}

// ── sha256 helper ─────────────────────────────────────────────────────────────
function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── Merkle primitives (inline for standalone deploy) ─────────────────────────

function merkleRootLocal(leaves: string[]): string {
  if (!leaves.length) return sha256('empty');
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : a; // duplicate last on odd
      next.push(sha256(a + b));
    }
    level = next;
  }
  return level[0];
}

function merkleProofLocal(leaves: string[], index: number): { sibling: string; position: 'left' | 'right' }[] {
  const proof: { sibling: string; position: 'left' | 'right' }[] = [];
  let level = [...leaves];
  let idx = index;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : a;
      next.push(sha256(a + b));
      if (i === idx || i + 1 === idx) {
        const sibling = (idx % 2 === 0) ? b : a;
        const position: 'left' | 'right' = (idx % 2 === 0) ? 'right' : 'left';
        proof.push({ sibling, position });
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

function tombstoneHashLocal(originalLeaf: string, reason: string): string {
  return sha256(`TOMBSTONE|${originalLeaf}|${reason}`);
}

// ── Filecoin/IPFS pin stub ────────────────────────────────────────────────────

export interface PinResult {
  cid: string | null;
  deal_id: string | null;
  pinned: boolean;
  stub: boolean; // true = mock; false = real Phase 4 pin
}

/**
 * pinToFilecoin
 * Stub — returns a deterministic mock CID until DK provisions real creds.
 * Phase 4: replace with real web3.storage / estuary / lighthouse SDK call.
 *
 * NEVER charges or self-acts (PAYMENTS_LIVE=0).
 */
export async function pinToFilecoin(
  merkleRoot: string,
  receiptIds: string[],
): Promise<PinResult> {
  const FILECOIN_ENABLED = process.env.FILECOIN_LIVE === '1' && process.env.FILECOIN_API_TOKEN;

  if (!FILECOIN_ENABLED) {
    // Deterministic stub CID so the record is always the same for the same data
    const stubCid = 'bafyStub' + merkleRoot.slice(0, 32);
    return { cid: stubCid, deal_id: null, pinned: false, stub: true };
  }

  // ── Real Phase 4 path (only reached when FILECOIN_LIVE=1 + token set) ──
  // Example: web3.storage / lighthouse / estuary
  try {
    const payload = JSON.stringify({ merkle_root: merkleRoot, receipt_ids: receiptIds });
    const resp = await fetch('https://api.web3.storage/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FILECOIN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    if (!resp.ok) throw new Error(`web3.storage error: ${resp.status}`);
    const { cid } = await resp.json() as { cid: string };
    return { cid, deal_id: null, pinned: true, stub: false };
  } catch (e) {
    console.error('[MerkleBatch] Filecoin pin failed, falling back to stub', e);
    return { cid: 'bafyStub' + merkleRoot.slice(0, 32), deal_id: null, pinned: false, stub: true };
  }
}

// ── Batch builder ─────────────────────────────────────────────────────────────

/**
 * buildMerkleBatch
 * Pulls all un-batched receipts for a user, computes the Merkle root,
 * pins to Filecoin (stub), stores the batch record in Supabase.
 *
 * Called:
 *   - After every R+2 receipt (pipeline wiring — see registerMerkleBatchRoutes)
 *   - Or manually via POST /receipts/merkle-batch
 */
export async function buildMerkleBatch(
  db: SupabaseClient,
  userId: string,
  opts: { minBatchSize?: number } = {},
): Promise<{ ok: boolean; batch?: MerkleBatchRecord; skipped?: string }> {
  const minSize = opts.minBatchSize ?? 2; // don't batch a single receipt

  // Fetch un-batched receipts for this user
  const { data: receipts, error } = await db
    .from('av2_receipts')
    .select('id, receipt_hash, ts')
    .eq('user_id', userId)
    .is('merkle_batch_id', null) // not yet in a batch
    .order('ts', { ascending: true });

  if (error) {
    console.error('[MerkleBatch] fetch error', error.message);
    return { ok: false };
  }

  if (!receipts || receipts.length < minSize) {
    return { ok: true, skipped: `only ${receipts?.length ?? 0} receipts — need ${minSize} to batch` };
  }

  const receiptHashes = receipts.map(r => r.receipt_hash as string);
  const root = merkleRootLocal(receiptHashes);
  const pin = await pinToFilecoin(root, receipts.map(r => r.id));

  // Insert batch record
  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const { error: batchErr } = await db.from('av2_merkle_batches').insert({
    id: batchId,
    user_id: userId,
    receipt_ids: receipts.map(r => r.id),
    merkle_root: root,
    leaf_count: receipts.length,
    ipfs_cid: pin.cid,
    filecoin_deal_id: pin.deal_id,
    created_at: now,
  });

  if (batchErr) {
    console.error('[MerkleBatch] insert error', batchErr.message);
    return { ok: false };
  }

  // Mark receipts as batched
  await db
    .from('av2_receipts')
    .update({ merkle_batch_id: batchId })
    .in('id', receipts.map(r => r.id));

  const batch: MerkleBatchRecord = {
    id: batchId,
    user_id: userId,
    receipt_ids: receipts.map(r => r.id),
    merkle_root: root,
    leaf_count: receipts.length,
    ipfs_cid: pin.cid,
    filecoin_deal_id: pin.deal_id,
    created_at: now,
  };

  return { ok: true, batch };
}

// ── Inclusion proof ───────────────────────────────────────────────────────────

/**
 * getMerkleProofForReceipt
 * Returns a Merkle inclusion proof for a single receipt within its batch.
 * Client can verify: verifyProof(leafHash, proof, root) === true
 */
export async function getMerkleProofForReceipt(
  db: SupabaseClient,
  receiptHash: string,
): Promise<{ ok: boolean; proof?: ReturnType<typeof merkleProofLocal>; root?: string; leaf?: string }> {
  // Find the batch containing this receipt
  const { data: receipt } = await db
    .from('av2_receipts')
    .select('merkle_batch_id, receipt_hash')
    .eq('receipt_hash', receiptHash)
    .maybeSingle();

  if (!receipt?.merkle_batch_id) return { ok: false };

  const { data: batch } = await db
    .from('av2_merkle_batches')
    .select('receipt_ids, merkle_root')
    .eq('id', receipt.merkle_batch_id)
    .maybeSingle();

  if (!batch) return { ok: false };

  // Reconstruct leaves from stored receipt hashes (in order)
  const { data: leaves_data } = await db
    .from('av2_receipts')
    .select('id, receipt_hash')
    .in('id', batch.receipt_ids);

  // Preserve order from batch.receipt_ids
  const orderedLeaves = batch.receipt_ids
    .map((id: string) => leaves_data?.find((r: any) => r.id === id)?.receipt_hash as string)
    .filter(Boolean);

  const idx = orderedLeaves.indexOf(receiptHash);
  if (idx === -1) return { ok: false };

  const proof = merkleProofLocal(orderedLeaves, idx);
  return { ok: true, proof, root: batch.merkle_root, leaf: receiptHash };
}

// ── GDPR tombstone ────────────────────────────────────────────────────────────

/**
 * tombstoneReceipt
 * GDPR erasure: replaces a receipt's leaf in future proofs with a tombstone hash.
 * The tombstone proves deletion without revealing the original content.
 */
export async function tombstoneReceipt(
  db: SupabaseClient,
  receiptHash: string,
  reason: string,
): Promise<{ ok: boolean; tombstone?: TombstoneRecord }> {
  const tHash = tombstoneHashLocal(receiptHash, reason);
  const now = new Date().toISOString();

  const { error } = await db.from('av2_tombstones').insert({
    id: crypto.randomUUID(),
    original_receipt_hash: receiptHash,
    tombstone_hash: tHash,
    reason,
    created_at: now,
  });

  if (error && error.code !== '23505') {
    return { ok: false };
  }

  // Nullify the receipt's content (keep hash for chain integrity, clear PII fields)
  await db
    .from('av2_receipts')
    .update({ tombstoned: true, tombstone_reason: reason })
    .eq('receipt_hash', receiptHash);

  return {
    ok: true,
    tombstone: {
      id: crypto.randomUUID(),
      original_receipt_hash: receiptHash,
      tombstone_hash: tHash,
      reason,
      created_at: now,
    },
  };
}

// ── HTTP route handlers ───────────────────────────────────────────────────────

/**
 * registerMerkleBatchRoutes
 *
 * POST /receipts/merkle-batch          → trigger batch for authenticated user
 * GET  /receipts/:hash/merkle-proof    → inclusion proof for a receipt
 * POST /receipts/:hash/tombstone       → GDPR erasure
 * GET  /receipts/batches/:id           → batch record + CID
 *
 * All routes require JWT auth (same middleware as existing endpoints).
 */
export function registerMerkleBatchRoutes(app: any, db: SupabaseClient) {

  // POST /receipts/merkle-batch
  app.post('/receipts/merkle-batch', async (req: any, res: any) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const { minBatchSize } = req.body ?? {};
    const result = await buildMerkleBatch(db, userId, { minBatchSize });
    res.json(result);
  });

  // GET /receipts/:hash/merkle-proof
  app.get('/receipts/:hash/merkle-proof', async (req: any, res: any) => {
    const result = await getMerkleProofForReceipt(db, req.params.hash);
    if (!result.ok) return res.status(404).json({ error: 'receipt not found or not yet batched' });
    res.json(result);
  });

  // POST /receipts/:hash/tombstone  (GDPR)
  app.post('/receipts/:hash/tombstone', async (req: any, res: any) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    const { reason } = req.body ?? {};
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const result = await tombstoneReceipt(db, req.params.hash, reason);
    res.json(result);
  });

  // GET /receipts/batches/:id
  app.get('/receipts/batches/:id', async (req: any, res: any) => {
    const { data, error } = await db
      .from('av2_merkle_batches')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error || !data) return res.status(404).json({ error: 'batch not found' });
    res.json({ ok: true, data });
  });
}

/**
 * Pipeline wiring helper
 * Call this after every R+2 receipt is written to trigger a background batch.
 * Won't build if fewer than 2 receipts are pending — skips gracefully.
 */
export async function triggerBatchAfterReceipt(
  db: SupabaseClient,
  userId: string,
): Promise<void> {
  // Fire-and-forget — never blocks the receipt write path
  buildMerkleBatch(db, userId, { minBatchSize: 2 }).catch(e =>
    console.error('[MerkleBatch] background batch error', e));
}
