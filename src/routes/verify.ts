// src/routes/verify.ts  (CW13 surface — integration impl by CW16)
// Verification Authority. Human-in-the-loop: approve is a human action that
// issues an ed25519 receipt (Atlas interface). Public reads see only
// human_verified (RLS). 5 entity types.
import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { svc, rls, ok, fail, h } from './_helpers';
import { issueReceipt } from './atlas_sign';

const ENTITY_TYPES = ['athlete', 'academy', 'coach', 'league', 'scout'];

export const verifyRouter = Router();

// GET /verify/pending — the review queue (pending submissions)
verifyRouter.get('/verify/pending', requireAuth, h(async (req: AuthedRequest, res) => {
  const { data, error } = await svc()
    .from('sports_verifications').select('*').eq('status', 'pending').order('ts', { ascending: false }).limit(50);
  if (error) return fail(res, 400, error.message);
  return ok(res, { pending: data ?? [] });
}));

// POST /verify/:entityType/:id — submit evidence (status: pending)
verifyRouter.post('/verify/:entityType/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const { entityType, id } = req.params;
  if (!ENTITY_TYPES.includes(entityType)) return fail(res, 400, `entity_type must be ${ENTITY_TYPES.join('|')}`);
  const { evidence_url } = req.body ?? {};
  const { data, error } = await svc()
    .from('sports_verifications')
    .insert({ entity_type: entityType, entity_id: id, status: 'pending', evidence_url, ts: new Date().toISOString() })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// POST /verify/:id/approve — HUMAN verifier action; issues signed receipt
verifyRouter.post('/verify/:id/approve', requireAuth, h(async (req: AuthedRequest, res) => {
  const s = svc();
  const { data: row, error } = await s.from('sports_verifications').select('*').eq('id', req.params.id).single();
  if (error || !row) return fail(res, 404, 'verification not found');

  let sig: string | null = null;
  try {
    const receipt = issueReceipt({
      subject_type: row.entity_type,
      subject_id: row.entity_id,
      attestation: 'human_verified',
      attested_by: req.body?.verifier_id ?? 'verifier',
      prev_hash: null,
    });
    sig = receipt.sig;
  } catch (e: any) {
    // Fail-closed: if signing key isn't provisioned we do NOT fake a badge.
    return fail(res, 503, `cannot issue verified badge: ${e.message}`);
  }

  const { error: upErr } = await s
    .from('sports_verifications')
    .update({ status: 'human_verified', verified_by: req.body?.verifier_id ?? 'verifier', sig })
    .eq('id', req.params.id);
  if (upErr) return fail(res, 400, upErr.message);
  return ok(res, { id: req.params.id, status: 'human_verified', signed: true });
}));

// GET /verify/:id/status — RLS: public sees only human_verified
verifyRouter.get('/verify/:id/status', requireAuth, h(async (req: AuthedRequest, res) => {
  const db = rls(req)!;
  const { data, error } = await db.from('sports_verifications').select('status,entity_type,sig').eq('id', req.params.id).maybeSingle();
  if (error) return fail(res, 403, error.message);
  if (!data) return fail(res, 404, 'not found or not visible');
  return ok(res, data);
}));
