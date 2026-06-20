// src/routes/vision.ts  (CW15 surface — integration impl by CW16)
// Vision pipeline: job intake is real; CV output is DARK (#10) — we never
// fabricate AI. Talent Index = heuristic composite, estimate-labeled (S4).
// Performance Lab fitness tests = real data.
import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { svc, rls, ok, fail, h } from './_helpers';
import { EstimateEnvelope } from '../types';

export const visionRouter = Router();

// POST /vision/jobs — accept a video job (queued); CV worker is DARK
visionRouter.post('/vision/jobs', requireAuth, h(async (req: AuthedRequest, res) => {
  const { match_id, video_url } = req.body ?? {};
  if (!video_url) return fail(res, 400, 'video_url required');
  const { data, error } = await svc()
    .from('sports_vision_jobs')
    .insert({ match_id, video_url, status: 'queued', version: 'v1' })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, { ...data, note: 'queued — CV model DARK (#10); no fabricated output' });
}));

// GET /vision/jobs/:id — status only; outputs appear when the real model runs
visionRouter.get('/vision/jobs/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const { data, error } = await svc().from('sports_vision_jobs').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return fail(res, 400, error.message);
  if (!data) return fail(res, 404, 'job not found');
  return ok(res, data);
}));

// GET /athletes/:id/talent — heuristic composite, estimate-labeled
visionRouter.get('/athletes/:id/talent', requireAuth, h(async (req: AuthedRequest, res) => {
  const db = rls(req)!;
  // pull real aggregated stats the athlete is allowed to expose
  const { data: stats, error } = await db.from('sports_athlete_stats').select('*').eq('athlete_id', req.params.id);
  if (error) return fail(res, 403, error.message);
  const composite = heuristicTalent(stats ?? []);
  const env: EstimateEnvelope = {
    value: composite.value,
    confidence: composite.confidence,
    estimate: true,
    source: 'talent',
    model_version: null, // heuristic — no trained model
    generated_at: new Date().toISOString(),
    human_reviewed: false,
  };
  return ok(res, { athlete_id: req.params.id, talent_index: env, sub_scores: composite.sub });
}));

// POST /fitness-tests — Performance Lab (real measured data, not AI)
visionRouter.post('/fitness-tests', requireAuth, h(async (req: AuthedRequest, res) => {
  const { athlete_id, type, value, date } = req.body ?? {};
  const { data, error } = await svc()
    .from('sports_fitness_tests')
    .insert({ athlete_id, type, value, date })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

/** Transparent heuristic: normalizes batting/bowling/fielding ratings into a
 *  0..100 composite. Confidence scales with sample size. NOT a trained model
 *  — labeled estimate so no one mistakes it for validated intelligence. */
export function heuristicTalent(stats: Array<any>) {
  if (stats.length === 0) {
    return { value: 0, confidence: 0, sub: { batting: 0, bowling: 0, fielding: 0 } };
  }
  const avg = (k: string) =>
    stats.reduce((s, r) => s + (Number(r[k]) || 0), 0) / stats.length;
  const batting = clamp(avg('batting_rating'));
  const bowling = clamp(avg('bowling_rating'));
  const fielding = clamp(avg('fielding_rating'));
  const value = Math.round((batting * 0.45 + bowling * 0.4 + fielding * 0.15));
  const totalMatches = stats.reduce((s, r) => s + (Number(r.matches) || 0), 0);
  const confidence = Math.min(1, totalMatches / 50); // 50+ matches => full confidence
  return { value, confidence: Number(confidence.toFixed(2)), sub: { batting, bowling, fielding } };
}

function clamp(n: number) {
  return Math.max(0, Math.min(100, Math.round(n)));
}
