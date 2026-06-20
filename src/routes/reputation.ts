// CW13 v3.0 — public reputation routes (extracted from CW13 verify lane to avoid overlapping the gateway verify router).
// Trust scores from signed, human-verified events; anti-gaming (verifier-diversity weighted); estimate-labeled; no PII.
import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { ok, fail, h } from './_helpers';
import { reputation, reputationBoard } from '../cw13/services/reputation';

export const reputationRouter = Router();

// public aggregate trust score (no verifier ids exposed)
reputationRouter.get('/reputation/:entityType/:id', h(async (req, res) => {
  return ok(res, await reputation(req.params.entityType, req.params.id));
}));

// gated leaderboard (verifier/admin/federation)
reputationRouter.get('/reputation-board/:entityType', requireAuth, h(async (req: AuthedRequest, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 20);
  return ok(res, await reputationBoard(req.params.entityType, limit));
}));
