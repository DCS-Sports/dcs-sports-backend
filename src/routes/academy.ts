// src/routes/academy.ts  (CW11 surface — integration impl by CW16)
// Academy + Coach OS. Add-player LINKS a self-owned athlete (consent stays
// with athlete/parent). Payments = ledger UI only, rail DARK (no collection).
import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { svc, rls, ok, fail, h } from './_helpers';

export const academyRouter = Router();

// POST /academies/:id/players — link an existing athlete to the academy
academyRouter.post('/academies/:id/players', requireAuth, h(async (req: AuthedRequest, res) => {
  const { athlete_id } = req.body ?? {};
  if (!athlete_id) return fail(res, 400, 'athlete_id required');
  const { data, error } = await svc()
    .from('sports_academy_players')
    .insert({ academy_id: req.params.id, athlete_id, joined_at: new Date().toISOString(), status: 'active' })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// POST /attendance — mark attendance
academyRouter.post('/attendance', requireAuth, h(async (req: AuthedRequest, res) => {
  const { athlete_id, academy_id, date, present, note } = req.body ?? {};
  const { data, error } = await svc()
    .from('sports_attendance')
    .insert({ athlete_id, academy_id, date, present: Boolean(present), note })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// POST /assessments — coach assessment (scores_json)
academyRouter.post('/assessments', requireAuth, h(async (req: AuthedRequest, res) => {
  const { athlete_id, coach_id, scores_json, date } = req.body ?? {};
  const { data, error } = await svc()
    .from('sports_assessments')
    .insert({ athlete_id, coach_id, scores_json, date })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// POST /training-plans
academyRouter.post('/training-plans', requireAuth, h(async (req: AuthedRequest, res) => {
  const { coach_id, athlete_id, plan_json } = req.body ?? {};
  const { data, error } = await svc()
    .from('sports_training_plans')
    .insert({ coach_id, athlete_id, plan_json, created_at: new Date().toISOString() })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// GET /academies/:id/analytics — real counts from the DB (growth/retention proxy)
academyRouter.get('/academies/:id/analytics', requireAuth, h(async (req: AuthedRequest, res) => {
  const s = svc();
  const [players, present] = await Promise.all([
    s.from('sports_academy_players').select('athlete_id', { count: 'exact', head: true }).eq('academy_id', req.params.id),
    s.from('sports_attendance').select('id', { count: 'exact', head: true }).eq('academy_id', req.params.id).eq('present', true),
  ]);
  return ok(res, {
    academy_id: req.params.id,
    player_count: players.count ?? 0,
    present_marks: present.count ?? 0,
  });
}));
