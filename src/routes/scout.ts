// src/routes/scout.ts  (CW14 surface — integration impl by CW16)
// Scout reads go THROUGH RLS — minors/private rows never leak. CW14 owns the
// Trials orchestration seam: Athlete -> Trial -> Scout -> Selection.
// Trials + watchlists persist once CW9 applies migration 004; logic is live.
import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { svc, rls, ok, fail, h } from './_helpers';
import { buildSelectionSuggestion, buildSelectionAlert } from './trials_orchestration';

export const scoutRouter = Router();

// GET /scout/search — RLS-filtered discovery (minors non-discoverable by default)
scoutRouter.get('/scout/search', requireAuth, h(async (req: AuthedRequest, res) => {
  const db = rls(req)!;
  const { sport, role, state } = req.query;
  let q = db.from('sports_athletes').select('id,sport,role,state,district,verified_status,visibility');
  if (sport) q = q.eq('sport', String(sport));
  if (role) q = q.eq('role', String(role));
  if (state) q = q.eq('state', String(state));
  const { data, error } = await q.limit(50);
  if (error) return fail(res, 403, error.message);
  return ok(res, { results: data ?? [], note: 'RLS-filtered; minors non-discoverable by default' });
}));

// ---- WATCHLISTS (persist on migration 004) ----
scoutRouter.post('/watchlists', requireAuth, h(async (req: AuthedRequest, res) => {
  const { scout_user_id, name } = req.body ?? {};
  if (!scout_user_id) return fail(res, 400, 'scout_user_id required');
  const { data, error } = await svc()
    .from('sports_watchlists')
    .insert({ scout_user_id, name: name ?? 'Default' })
    .select()
    .single();
  if (error) return fail(res, 400, `${error.message} (needs migration 004 if table missing)`);
  return ok(res, data);
}));

scoutRouter.post('/watchlists/:id/items', requireAuth, h(async (req: AuthedRequest, res) => {
  const { athlete_id, note } = req.body ?? {};
  if (!athlete_id) return fail(res, 400, 'athlete_id required');
  const { data, error } = await svc()
    .from('sports_watchlist_items')
    .insert({ watchlist_id: req.params.id, athlete_id, note })
    .select()
    .single();
  if (error) return fail(res, 400, `${error.message} (needs migration 004 if table missing)`);
  return ok(res, data);
}));

// ---- VERIFIED TRIALS NETWORK (CW14 orchestration owner) ----
// Flow: create trial -> athlete registers -> host records results+selection
//       -> selection result is a HUMAN-recorded fact (not auto-AI).

scoutRouter.post('/trials', requireAuth, h(async (req: AuthedRequest, res) => {
  const { name, host_user_id, sport, level, venue, scheduled_at, visibility } = req.body ?? {};
  if (!name || !sport) return fail(res, 400, 'name and sport required');
  const { data, error } = await svc()
    .from('sports_trials')
    // host defaults to the authenticated user
    .insert({ name, host_user_id: host_user_id ?? req.userId, sport, level, venue, scheduled_at, visibility: visibility ?? 'discoverable' })
    .select()
    .single();
  if (error) return fail(res, 400, `${error.message} (needs migration 004 if table missing)`);
  return ok(res, data);
}));

// GET /trials — list open/discoverable trials
scoutRouter.get('/trials', requireAuth, h(async (req: AuthedRequest, res) => {
  let q = svc().from('sports_trials').select('*').order('created_at', { ascending: false });
  const sport = (req.query?.sport as string) || '';
  if (sport) q = q.eq('sport', sport);
  const { data, error } = await q;
  if (error) return fail(res, 400, error.message);
  return ok(res, { trials: data ?? [] });
}));

scoutRouter.post('/trials/:id/register', requireAuth, h(async (req: AuthedRequest, res) => {
  const { athlete_id } = req.body ?? {};
  if (!athlete_id) return fail(res, 400, 'athlete_id required');
  const { data, error } = await svc()
    .from('sports_trial_registrations')
    .insert({ trial_id: req.params.id, athlete_id, status: 'registered' })
    .select()
    .single();
  if (error) return fail(res, 400, `${error.message} (needs migration 004 if table missing)`);
  return ok(res, data);
}));

scoutRouter.post('/trials/:id/results', requireAuth, h(async (req: AuthedRequest, res) => {
  // Selection is a human action (recorded_by). High-stakes outcome — not AI-auto.
  const { athlete_id, scores_json, selected, selection_note, recorded_by, trial_name } = req.body ?? {};
  if (!athlete_id) return fail(res, 400, 'athlete_id required');
  if (!recorded_by) return fail(res, 400, 'recorded_by (human) required — selection is human-in-loop');
  const s = svc();
  const { data, error } = await s
    .from('sports_trial_results')
    .upsert(
      { trial_id: req.params.id, athlete_id, scores_json, selected: Boolean(selected), selection_note, recorded_by, recorded_at: new Date().toISOString() },
      { onConflict: 'trial_id,athlete_id' }
    )
    .select()
    .single();
  if (error) return fail(res, 400, `${error.message} (needs migration 004 if table missing)`);

  // M-S3 seam: a selection becomes a high-stakes (pending) suggestion + alert.
  const outcome = {
    trial_id: req.params.id,
    athlete_id,
    league_or_trial_name: trial_name ?? 'Trial',
    selected: Boolean(selected),
    recorded_by,
  };
  const suggestion = buildSelectionSuggestion(outcome);
  const alerts = buildSelectionAlert(outcome);
  // persist the suggestion (pending — gate enforces human action to take effect)
  await s.from('sports_agent_suggestions').insert({ ...suggestion, created_at: new Date().toISOString() });

  return ok(res, { result: data, suggestion_status: 'pending_human_action', alerts });
}));
