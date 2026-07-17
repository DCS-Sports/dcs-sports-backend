// src/routes/league.ts  (CW12 surface — integration impl by CW16)
// League OS — the data factory. Ball-by-ball scoring writes sports_live_scores
// AND folds into sports_match_performances (the M-S1 chain CW10 reads).
import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { svc, ok, fail, h } from './_helpers';
import { generateFixtures } from './fixtures';
import { emptyPerformance, applyBall } from '../gateway/incremental';
import { BallEvent } from '../types';

export const leagueRouter = Router();

// POST /leagues
leagueRouter.post('/leagues', requireAuth, h(async (req: AuthedRequest, res) => {
  const { name, organizer_user_id, format, level, season } = req.body ?? {};
  const { data, error } = await svc()
    .from('sports_leagues')
    // organizer defaults to the authenticated user (requireAuth sets req.userId)
    .insert({ name, organizer_user_id: organizer_user_id ?? req.userId, format, level, season })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// POST /leagues/:id/fixtures/generate
leagueRouter.post('/leagues/:id/fixtures/generate', requireAuth, h(async (req: AuthedRequest, res) => {
  const { format, team_ids } = req.body ?? {};
  if (!Array.isArray(team_ids) || team_ids.length < 2) return fail(res, 400, 'team_ids[] (>=2) required');
  const fixtures = generateFixtures(format, team_ids).map((f) => ({
    league_id: req.params.id,
    round: f.round,
    home_team_id: f.home_team_id,
    away_team_id: f.away_team_id,
  }));
  const { data, error } = await svc().from('sports_fixtures').insert(fixtures).select();
  if (error) return fail(res, 400, error.message);
  return ok(res, { count: fixtures.length, fixtures: data });
}));

// POST /matches/:id/score — ball-by-ball; persists event + recomputes performance
leagueRouter.post('/matches/:id/score', requireAuth, h(async (req: AuthedRequest, res) => {
  const ev = req.body as Partial<BallEvent>;
  if (!ev.athlete_id || !ev.event) return fail(res, 400, 'athlete_id and event required');
  const event: BallEvent = {
    match_id: req.params.id,
    athlete_id: ev.athlete_id,
    event: ev.event,
    runs: ev.runs,
    ball: ev.ball ?? 0,
    over: ev.over ?? 0,
    ts: new Date().toISOString(),
  };
  const s = svc();
  // 1) append to live scores (append-only audit of every ball)
  const { error: lsErr } = await s.from('sports_live_scores').insert({
    match_id: event.match_id,
    innings: 1,
    over: event.over,
    ball: event.ball,
    event_json: event,
    ts: event.ts,
  });
  if (lsErr) return fail(res, 400, lsErr.message);

  // 2) INCREMENTAL fold: read this athlete's current performance, apply just
  //    the new ball (O(1)), upsert. No full re-read of all events — scales to
  //    240+ ball matches without O(n²) growth.
  const { data: existing } = await s
    .from('sports_match_performances')
    .select('*')
    .eq('match_id', event.match_id)
    .eq('athlete_id', event.athlete_id)
    .maybeSingle();
  const base = existing
    ? {
        match_id: event.match_id, athlete_id: event.athlete_id,
        runs: existing.runs ?? 0, balls: existing.balls ?? 0, fours: existing.fours ?? 0,
        sixes: existing.sixes ?? 0, wickets: existing.wickets ?? 0, catches: existing.catches ?? 0,
        source: 'match' as const,
      }
    : emptyPerformance(event.match_id, event.athlete_id);
  const perf = applyBall(base, event);

  // 3) upsert into sports_match_performances (source='match')
  const { error: upErr } = await s
    .from('sports_match_performances')
    .upsert(
      { match_id: perf.match_id, athlete_id: perf.athlete_id, runs: perf.runs, balls: perf.balls,
        fours: perf.fours, sixes: perf.sixes, wickets: perf.wickets, catches: perf.catches, source: 'match' },
      { onConflict: 'match_id,athlete_id' }
    );
  if (upErr) return fail(res, 400, upErr.message);

  return ok(res, { recorded: event, performance: perf });
}));

// GET /leagues/:id/standings — wins per team from completed matches
leagueRouter.get('/leagues/:id/standings', requireAuth, h(async (req: AuthedRequest, res) => {
  const { data, error } = await svc()
    .from('sports_matches')
    .select('home_team_id,away_team_id,result,status')
    .eq('league_id', req.params.id);
  if (error) return fail(res, 400, error.message);
  return ok(res, { matches: data ?? [] });
}));
