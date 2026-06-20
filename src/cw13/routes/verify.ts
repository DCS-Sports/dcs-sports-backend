// CW13 — routes. Frozen S2 surface:
//   POST /verify/:entityType/:id   -> submit evidence
//   POST /verify/:id/approve       -> human approve (issues badge + sig)
//   POST /verify/:id/reject        -> reject (CW13 extension, advisory)
//   POST /verify/:id/ai-pass       -> AI pre-check pass (advisory, not a badge)
//   GET  /verify/:id/status        -> current row
//   GET  /verify/queue?status=     -> admin review queue (verifier/admin only)
//   GET  /domestic/:athleteId/season/:s -> season summary + estimate signal

import { Router, type Request, type Response } from 'express';
import type { EntityType } from '../lib/contracts';
import {
  submitVerification,
  approveVerification,
  rejectVerification,
  markAiPassed,
  getStatus,
  reviewQueue,
  publicBadge,
  publicProof,
  getChain,
  revokeVerification,
  verifierMetrics,
} from '../services/verification';
import { domesticSeason, career } from '../services/domestic';
import { rankPool, recordDecision } from '../services/committee';
import { nameSquad, listSquads } from '../services/squad';
import { inbox, action } from '../services/inbox';
import { callerId } from '../lib/auth';
import { auditExport } from '../services/audit-export';
import { reputation, reputationBoard } from '../services/reputation';

export const router = Router();

// auth/role is enforced by CW9's gateway middleware (verifier/admin only for
// approve/reject/queue). Day-0: verifier id read from a header.
// Caller identity for human-action attribution. Prefers a real Supabase JWT
// (once CW9 auth is live), falls back to x-user-id for Day-0/local.
function verifierId(req: Request): string {
  return callerId(req);
}

// Admin review queue — register BEFORE the param routes so "queue" isn't
// captured as an :id.
router.get('/verify/queue', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string | undefined) as any;
    return res.json(await reviewQueue(status));
  } catch (e) {
    return fail(res, e);
  }
});

// Submit restricted to the 5 valid entity types via a regex param so it cannot
// shadow the action routes (e.g. /verify/<uuid>/approve) below.
router.post('/verify/:entityType(athlete|academy|coach|league|scout)/:id', async (req: Request, res: Response) => {
  try {
    const { entityType, id } = req.params;
    const evidence = (req.body?.evidence_url as string) ?? null;
    const row = await submitVerification(entityType as EntityType, id, evidence);
    return res.status(201).json(row);
  } catch (e) {
    return fail(res, e);
  }
});

router.post('/verify/:id/ai-pass', async (req: Request, res: Response) => {
  try {
    const signal = req.body?.signal;
    const { row, assessment } = await markAiPassed(req.params.id, signal);
    return res.json({ ...row, assessment });
  } catch (e) {
    return fail(res, e);
  }
});

router.post('/verify/:id/approve', async (req: Request, res: Response) => {
  const uid = verifierId(req);
  if (!uid) return res.status(401).json({ error: 'HUMAN_REQUIRED', detail: 'x-user-id (verifier) missing' });
  try {
    const validDays = Number(req.body?.valid_days) || undefined;
    return res.json(await approveVerification(req.params.id, uid, { validDays }));
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('ATLAS_NOT_WIRED')) {
      return res.status(503).json({ error: 'ATLAS_NOT_WIRED', detail: msg });
    }
    return fail(res, e);
  }
});

// Revoke a live badge (human action, signed revocation appended to the chain).
// Body: { reason }
router.post('/revoke/:entityType/:id', async (req: Request, res: Response) => {
  const uid = verifierId(req);
  if (!uid) return res.status(401).json({ error: 'HUMAN_REQUIRED', detail: 'x-user-id (verifier) missing' });
  try {
    const row = await revokeVerification(req.params.entityType as EntityType, req.params.id, uid, req.body?.reason ?? '');
    return res.status(201).json(row);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('ATLAS_NOT_WIRED')) return res.status(503).json({ error: 'ATLAS_NOT_WIRED', detail: msg });
    if (msg.startsWith('NOT_VERIFIED')) return res.status(409).json({ error: msg });
    return fail(res, e);
  }
});

// Admin-dashboard verification metrics. Verifier/admin only.
router.get('/metrics', async (_req: Request, res: Response) => {
  try {
    return res.json(await verifierMetrics());
  } catch (e) {
    return fail(res, e);
  }
});

// Federation-grade audit export — signed, downloadable, independently verifiable.
// Verifier/admin/federation only (contains attested_by). Served as a file
// attachment so it downloads. Verify offline with tools/verify-export.mjs.
router.get('/audit-export/:entityType/:id', async (req: Request, res: Response) => {
  const uid = verifierId(req);
  if (!uid) return res.status(401).json({ error: 'HUMAN_REQUIRED', detail: 'federation/verifier auth required' });
  try {
    const { entityType, id } = req.params;
    const bundle = await auditExport(entityType as EntityType, id);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="dcs-audit-${entityType}-${id}.json"`);
    return res.status(200).send(JSON.stringify(bundle, null, 2));
  } catch (e) {
    return fail(res, e);
  }
});

router.post('/verify/:id/reject', async (req: Request, res: Response) => {
  const uid = verifierId(req);
  if (!uid) return res.status(401).json({ error: 'HUMAN_REQUIRED' });
  try {
    return res.json(await rejectVerification(req.params.id, uid, req.body?.reason));
  } catch (e) {
    return fail(res, e);
  }
});

router.get('/verify/:id/status', async (req: Request, res: Response) => {
  try {
    return res.json(await getStatus(req.params.id));
  } catch (e) {
    return fail(res, e);
  }
});

// Verifier-facing provable audit trail — hash-chained receipt history for an
// entity, with linkage integrity + per-link signature validity.
router.get('/audit/:entityType/:id', async (req: Request, res: Response) => {
  try {
    const { entityType, id } = req.params;
    return res.json(await getChain(entityType as EntityType, id));
  } catch (e) {
    return fail(res, e);
  }
});

router.get('/domestic/:athleteId/season/:s', async (req: Request, res: Response) => {
  try {
    return res.json(await domesticSeason(req.params.athleteId, req.params.s));
  } catch (e) {
    return fail(res, e);
  }
});

router.get('/domestic/:athleteId/career', async (req: Request, res: Response) => {
  try {
    return res.json(await career(req.params.athleteId));
  } catch (e) {
    return fail(res, e);
  }
});

// Selection committee — rank a candidate pool for a season (advisory).
// Body: { athlete_ids: string[] }
router.post('/committee/rank/:season', async (req: Request, res: Response) => {
  try {
    const ids = req.body?.athlete_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'POOL_REQUIRED', detail: 'body.athlete_ids must be a non-empty array' });
    }
    return res.json(await rankPool(ids, req.params.season));
  } catch (e) {
    return fail(res, e);
  }
});

// Record a committee decision (human action). Needs x-user-id (committee member).
// Body: { season, verdict: 'shortlist'|'hold'|'pass', rationale? }
router.post('/committee/decide/:athleteId', async (req: Request, res: Response) => {
  const uid = verifierId(req);
  if (!uid) return res.status(401).json({ error: 'HUMAN_REQUIRED', detail: 'x-user-id (committee member) missing' });
  const { season, verdict, rationale } = req.body ?? {};
  const allowed = ['shortlist', 'hold', 'pass'];
  if (!allowed.includes(verdict)) {
    return res.status(400).json({ error: 'INVALID_VERDICT', allowed });
  }
  try {
    const s = await recordDecision(req.params.athleteId, season ?? null, verdict, uid, rationale);
    return res.status(201).json(s);
  } catch (e) {
    return fail(res, e);
  }
});

// Name a squad (human action). Needs x-user-id (selector).
// Body: { name, tournament, season, members: [{athlete_id, role?}] }
router.post('/squads', async (req: Request, res: Response) => {
  const uid = verifierId(req);
  if (!uid) return res.status(401).json({ error: 'HUMAN_REQUIRED', detail: 'x-user-id (selector) missing' });
  const { name, tournament, season, members } = req.body ?? {};
  if (!name || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'SQUAD_INVALID', detail: 'name + non-empty members[] required' });
  }
  try {
    const { squad } = await nameSquad({ name, tournament: tournament ?? '', season: season ?? '', members, selectedBy: uid });
    return res.status(201).json(squad);
  } catch (e) {
    return fail(res, e);
  }
});

// List recorded squads (committee/association view). Optional ?tournament= &season=
router.get('/squads', async (req: Request, res: Response) => {
  try {
    const tournament = req.query.tournament as string | undefined;
    const season = req.query.season as string | undefined;
    return res.json(await listSquads({ tournament, season }));
  } catch (e) {
    return fail(res, e);
  }
});

// Agent-suggestions inbox — the 80/20 human action queue. Verifier/admin only.
// ?status=open|actioned  ?high_stakes=1
router.get('/inbox', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const highStakesOnly = req.query.high_stakes === '1' || req.query.high_stakes === 'true';
    return res.json(await inbox({ status, highStakesOnly }));
  } catch (e) {
    return fail(res, e);
  }
});

// Action a suggestion (human sign-off). Needs x-user-id. Body: { outcome }
router.post('/inbox/:id/action', async (req: Request, res: Response) => {
  const uid = verifierId(req);
  if (!uid) return res.status(401).json({ error: 'HUMAN_REQUIRED', detail: 'x-user-id missing' });
  const outcome = req.body?.outcome;
  if (!outcome) return res.status(400).json({ error: 'OUTCOME_REQUIRED' });
  try {
    return res.json(await action(req.params.id, uid, outcome));
  } catch (e) {
    return fail(res, e);
  }
});

// Public badge lookup — what the frontend calls to render "blue tick" badges
// anywhere. Goes through the ANON client so 003 RLS applies: only
// human_verified rows are ever returned to the public. Returns {verified:false}
// when no public badge exists (never leaks pending/ai_passed/rejected).
router.get('/badge/:entityType/:id', async (req: Request, res: Response) => {
  try {
    const { entityType, id } = req.params;
    const badge = await publicBadge(entityType as EntityType, id);
    return res.json(badge);
  } catch (e) {
    return fail(res, e);
  }
});

// Public PROOF — the public verify page. Badge state + a PII-redacted proof of
// the signed receipt chain (events/intact/signatures + a kind+timestamp
// timeline). No verifier ids, no auth. "Provable, not cosmetic" for anyone.
router.get('/verify-public/:entityType/:id', async (req: Request, res: Response) => {
  try {
    const { entityType, id } = req.params;
    return res.json(await publicProof(entityType as EntityType, id));
  } catch (e) {
    return fail(res, e);
  }
});

// Reputation (v3.0) — trust score from signed verified events, estimate-labeled.
// Aggregate over human_verified events; exposes no verifier ids. Public-safe.
router.get('/reputation/:entityType/:id', async (req: Request, res: Response) => {
  try {
    const { entityType, id } = req.params;
    const rep = await reputation(entityType, id);
    // strip the most_recent/oldest timestamps' precision is fine; no PII here.
    return res.json(rep);
  } catch (e) {
    return fail(res, e);
  }
});

// Reputation leaderboard for an entity type. Verifier/admin/federation.
router.get('/reputation-board/:entityType', async (req: Request, res: Response) => {
  const uid = verifierId(req);
  if (!uid) return res.status(401).json({ error: 'HUMAN_REQUIRED' });
  try {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    return res.json(await reputationBoard(req.params.entityType, limit));
  } catch (e) {
    return fail(res, e);
  }
});

function fail(res: Response, e: unknown) {
  const msg = (e as Error).message || 'ERROR';
  const code = msg.startsWith('NOT_FOUND') ? 404 : msg.startsWith('INVALID_TRANSITION') ? 409 : 400;
  return res.status(code).json({ error: msg });
}
