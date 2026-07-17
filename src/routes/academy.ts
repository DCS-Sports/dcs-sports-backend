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

// POST /academies — create an academy (owner = caller)
academyRouter.post('/academies', requireAuth, h(async (req: AuthedRequest, res) => {
  const { name, owner_name, city, state, country } = req.body ?? {};
  if (!name) return fail(res, 400, 'name required');
  const { data, error } = await svc()
    .from('sports_academies')
    .insert({ name, owner_user_id: req.userId, owner_name: owner_name ?? null, city: city ?? null, state: state ?? null, country: country ?? null })
    .select().single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// GET /academies — academies the caller owns
academyRouter.get('/academies', requireAuth, h(async (req: AuthedRequest, res) => {
  const { data, error } = await svc()
    .from('sports_academies').select('*').eq('owner_user_id', req.userId)
    .order('created_at', { ascending: false });
  if (error) return fail(res, 400, error.message);
  return ok(res, { academies: data ?? [] });
}));

// GET /academies/:id/players — roster
academyRouter.get('/academies/:id/players', requireAuth, h(async (req: AuthedRequest, res) => {
  const { data, error } = await svc()
    .from('sports_academy_players').select('*').eq('academy_id', req.params.id);
  if (error) return fail(res, 400, error.message);
  return ok(res, { players: data ?? [] });
}));

// PATCH /academies/:id — edit (owner only)
academyRouter.patch('/academies/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const patch: Record<string, any> = {};
  ['name', 'owner_name', 'city', 'state', 'country'].forEach((k) => { if (req.body?.[k] !== undefined) patch[k] = req.body[k]; });
  const { data, error } = await svc()
    .from('sports_academies').update(patch).eq('id', req.params.id).eq('owner_user_id', req.userId).select().single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// GET /assessments?athlete_id= — Coach OS
academyRouter.get('/assessments', requireAuth, h(async (req: AuthedRequest, res) => {
  let q = svc().from('sports_assessments').select('*').order('date', { ascending: false }).limit(50);
  const aid = (req.query?.athlete_id as string) || ''; if (aid) q = q.eq('athlete_id', aid);
  const { data, error } = await q; if (error) return fail(res, 400, error.message);
  return ok(res, { assessments: data ?? [] });
}));

// GET /training-plans?athlete_id= — Coach OS
academyRouter.get('/training-plans', requireAuth, h(async (req: AuthedRequest, res) => {
  let q = svc().from('sports_training_plans').select('*').order('created_at', { ascending: false }).limit(50);
  const aid = (req.query?.athlete_id as string) || ''; if (aid) q = q.eq('athlete_id', aid);
  const { data, error } = await q; if (error) return fail(res, 400, error.message);
  return ok(res, { plans: data ?? [] });
}));
