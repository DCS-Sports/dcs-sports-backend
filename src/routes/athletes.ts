// src/routes/athletes.ts  (CW10 surface — integration impl by CW16)
// Passport reads go THROUGH RLS (visibility + minor-gating at the DB).
// Ratings are pure aggregation from sports_match_performances — no AI.
import { Router } from 'express';
import { requireAuth, optionalAuth, AuthedRequest } from '../middleware/auth';
import { svc, rls, ok, fail, h } from './_helpers';
import * as passport from '../passport/repo/passport'; // CW10 passport repo (talent/recruiting/highlights/onboarding/vision)

export const athleteRouter = Router();
const tok = (req: AuthedRequest) => req.jwt ?? null; // RLS access token for scoped reads

// POST /athletes — onboarding: create/update the caller's OWN passport (id = user_id).
athleteRouter.post('/athletes', requireAuth, h(async (req: AuthedRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const row: Record<string, unknown> = { id: req.userId, user_id: req.userId,
    sport: b.sport || 'cricket', visibility: b.visibility || 'private' };
  for (const k of ['role','batting_style','bowling_style','state','district','dob']) {
    if (b[k] !== undefined) row[k] = b[k];
  }
  const { data, error } = await svc().from('sports_athletes').upsert(row, { onConflict: 'id' }).select('*').single();
  if (error) return fail(res, 400, error.message);
  return ok(res, { athlete: data });
}));

// GET /athletes/:id — RLS decides if the caller may see this row
athleteRouter.get('/athletes/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const db = rls(req)!;
  const { data, error } = await db.from('sports_athletes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return fail(res, 403, error.message);
  if (!data) {
    if (req.params.id === req.userId) {
      const { data: created } = await svc().from('sports_athletes')
        .insert({ id: req.userId, user_id: req.userId, sport: 'cricket', visibility: 'private' })
        .select('*').single();
      if (created) return ok(res, created);
      const { data: again } = await db.from('sports_athletes').select('*').eq('id', req.userId).maybeSingle(); // RLS-scoped re-read of caller's own row (no service-role bypass)
      if (again) return ok(res, again);
    }
    return fail(res, 404, 'athlete not visible or not found'); // RLS may hide it
  }
  return ok(res, data);
}));

// PATCH /athletes/:id/visibility — owner sets private|academy|discoverable|public
athleteRouter.patch('/athletes/:id/visibility', requireAuth, h(async (req: AuthedRequest, res) => {
  const { visibility } = req.body ?? {};
  const allowed = ['private', 'academy', 'discoverable', 'public'];
  if (!allowed.includes(visibility)) return fail(res, 400, `visibility must be one of ${allowed.join('|')}`);
  // service role write; ownership is enforced by RLS on the read side + app check
  const db = rls(req)!;
  const { data: own } = await db.from('sports_athletes').select('id').eq('id', req.params.id).maybeSingle();
  if (!own) return fail(res, 403, 'not your athlete row');
  const { error } = await svc().from('sports_athletes').update({ visibility }).eq('id', req.params.id);
  if (error) return fail(res, 400, error.message);
  return ok(res, { id: req.params.id, visibility });
}));

// GET /athletes/:id/stats — aggregated season stats (RLS-gated read)
athleteRouter.get('/athletes/:id/stats', requireAuth, h(async (req: AuthedRequest, res) => {
  const db = rls(req)!;
  const { data, error } = await db.from('sports_athlete_stats').select('*').eq('athlete_id', req.params.id);
  if (error) return fail(res, 403, error.message);
  return ok(res, { stats: data ?? [] });
}));

// POST /athletes/:id/media — attach media (owner)
athleteRouter.post('/athletes/:id/media', requireAuth, h(async (req: AuthedRequest, res) => {
  const { type, url } = req.body ?? {};
  const { data, error } = await svc()
    .from('sports_media')
    .insert({ athlete_id: req.params.id, type, url, created_at: new Date().toISOString() })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// GET /parents/:id/children — parent's linked + consented children
athleteRouter.get('/parents/:id/children', requireAuth, h(async (req: AuthedRequest, res) => {
  const db = rls(req)!;
  const { data, error } = await db
    .from('sports_parent_links')
    .select('athlete_id, relation, consent')
    .eq('parent_user_id', req.params.id);
  if (error) return fail(res, 403, error.message);
  return ok(res, { children: data ?? [] });
}));

/* ============================================================================
 * CW10 v2.0 passport surface — talent (aiScout), highlights, recruiting,
 * onboarding, vision submit, timeline, progress. Reads go through RLS via the
 * caller's JWT; writes use service role inside the repo. All AI estimate-labeled
 * + model-DARK; minors stay non-discoverable at RLS.
 * ==========================================================================*/

// GET /athletes/me/passport — first-login get-or-create (onboarding_needed flag)
athleteRouter.get('/athletes/me/passport', requireAuth, h(async (req: AuthedRequest, res) => {
  if (!req.userId) return fail(res, 401, 'auth_required');
  return ok(res, await passport.getOrCreateMyPassport(req.userId, tok(req)));
}));

// POST /athletes/:id/onboarding — set initial sport/role/styles
athleteRouter.post('/athletes/:id/onboarding', requireAuth, h(async (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as any;
  if (!body.role) return fail(res, 400, 'role_required');
  const updated = await passport.completeOnboarding(req.params.id, body);
  if (!updated) return fail(res, 404, 'not_found');
  return ok(res, { athlete: updated, onboarding_complete: true });
}));

// PATCH /athletes/:id — update passport profile fields (not visibility)
athleteRouter.patch('/athletes/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const updated = await passport.updateAthlete(req.params.id, (req.body ?? {}) as any);
  if (!updated) return fail(res, 404, 'not_found');
  return ok(res, { athlete: updated });
}));

// GET /athletes/:id/timeline
athleteRouter.get('/athletes/:id/timeline', requireAuth, h(async (req: AuthedRequest, res) => {
  return ok(res, { athlete_id: req.params.id, timeline: await passport.getTimeline(req.params.id, tok(req)) });
}));

// GET /athletes/:id/progress — performance series for charts
athleteRouter.get('/athletes/:id/progress', requireAuth, h(async (req: AuthedRequest, res) => {
  return ok(res, { athlete_id: req.params.id, progress: await passport.getProgress(req.params.id, tok(req)) });
}));

// POST /athletes/:id/vision — aiScout drill / match clip → CW15 worker queue
athleteRouter.post('/athletes/:id/vision', requireAuth, h(async (req: AuthedRequest, res) => {
  const videoUrl = (req.body ?? {}).video_url;
  if (!videoUrl) return fail(res, 400, 'video_url_required');
  const kind = (req.body ?? {}).kind === 'match_clip' ? 'match_clip' : 'drill';
  const job = await passport.submitVisionJob(req.params.id, kind, videoUrl);
  return res.status(201).json({ job, _note: 'queued for CW15 vision worker; talent estimate + highlight appear when processed (model DARK).' });
}));

// GET /athletes/:id/talent — talent estimate (estimate-labeled; model DARK)
athleteRouter.get('/athletes/:id/talent', requireAuth, h(async (req: AuthedRequest, res) => {
  return ok(res, { talent: await passport.getTalentEstimate(req.params.id, tok(req)) });
}));

// GET /athletes/:id/highlights — auto-highlights (CW15 output; honest empty)
athleteRouter.get('/athletes/:id/highlights', requireAuth, h(async (req: AuthedRequest, res) => {
  return ok(res, { highlights: await passport.getHighlights(req.params.id, tok(req)) });
}));

// GET /athletes/:id/recruiting — public scout-facing exposure profile (RLS-safe; hidden==absent)
athleteRouter.get('/athletes/:id/recruiting', optionalAuth, h(async (req: AuthedRequest, res) => {
  const profile = await passport.getRecruitingProfile(req.params.id, tok(req));
  if (!profile) return fail(res, 404, 'not_found');
  return ok(res, { profile });
}));

/* ===== CW10 v3.0 Career tab — Career GPS, Digital Twin, Athlete AI Agent, Verified Selection History
 * All estimate-labeled / data-gated; agent suggests but never self-acts; minors RLS-gated. ===== */

// GET /athletes/:id/career-gps — pathway level→milestone→gap→plan (estimate + confidence)
athleteRouter.get('/athletes/:id/career-gps', requireAuth, h(async (req: AuthedRequest, res) => {
  return ok(res, { career_gps: await passport.getCareerGPS(req.params.id, tok(req)) });
}));

// GET /athletes/:id/digital-twin — conservative workload/injury-risk estimate (honest "insufficient" when gated)
athleteRouter.get('/athletes/:id/digital-twin', requireAuth, h(async (req: AuthedRequest, res) => {
  return ok(res, { digital_twin: await passport.getDigitalTwin(req.params.id, tok(req)) });
}));

// GET /athletes/:id/agent-pings — human-gated suggestions (agent suggests, never acts)
athleteRouter.get('/athletes/:id/agent-pings', requireAuth, h(async (req: AuthedRequest, res) => {
  return ok(res, { pings: await passport.getAgentPings(req.params.id, tok(req)) });
}));

// PATCH /athletes/:id/agent-pings/:pingId — athlete acknowledges/dismisses/actions a ping (no auto/self-action)
athleteRouter.patch('/athletes/:id/agent-pings/:pingId', requireAuth, h(async (req: AuthedRequest, res) => {
  const status = (req.body ?? {}).status;
  if (!['acknowledged', 'dismissed', 'actioned'].includes(status)) return fail(res, 400, 'invalid status (acknowledged|dismissed|actioned)');
  const updated = await passport.setPingStatus(req.params.pingId, status);
  if (!updated) return fail(res, 404, 'not_found');
  return ok(res, { ping: updated });
}));

// GET /athletes/:id/selection-history — ed25519-signed selection records (public verify link)
athleteRouter.get('/athletes/:id/selection-history', optionalAuth, h(async (req: AuthedRequest, res) => {
  return ok(res, { selection_history: await passport.getSelectionHistory(req.params.id, tok(req)) });
}));
