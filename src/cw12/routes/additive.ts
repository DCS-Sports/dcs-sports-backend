// CW12 — ADDITIVE v3.0 router (reconciliation-safe).
//
// The live gateway already has CW12's core league + O(1) ball-by-ball scoring mounted
// (per the handover: "preserve the O(1) scoring that's live"). This router carries ONLY
// the net-new v3.0 capabilities that layer on top WITHOUT touching the live scoring path:
//   - smart-camera ingest + tracked-event highlights
//   - broadcast page view model
//   - shareable match page view model
//   - auto-highlights (event-derived)
//   - rankings, certificates, form analytics (read-only derivations)
//   - multi-sport discovery + generic scoring (/event) for football/kabaddi
//
// These are read-models + ingest seams over data the live scoring already writes
// (sports_match_performances, sports_live_scores) — they do not re-implement scoring.
// CW16 mounts THIS router additively; the live /matches/:id/score path is untouched.
//
// If a route here collides with something already live (e.g. /matches/:id/center),
// CW16 can mount with `skipReconciled: true` to omit the overlap set — see mountCW12Additive.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { db } from '../db/store';
import * as repo from '../db/repo';
import { toPerformanceRows } from '../services/scoringEngine';
import { computeStandings, computeLeaderboard } from '../services/standings';
import { rankAthletes, buildCertificates, type RankingCategory } from '../services/rankings';
import { leagueForm, computeForm } from '../services/formAnalytics';
import { buildCommentary, buildScorecard, dismissedFrom } from '../services/matchCenter';
import { buildHighlights } from '../services/highlights';
import { registerCameraFeed, ingestTrackedEvents, type TrackedEvent } from '../services/smartCamera';
import { requireScorer } from '../middleware/requireScorer';
import { listSports, scoringModelFor } from '../services/sportConfig';
import type { MatchPerformance } from '../types/index';

const h = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export const additiveRouter = Router();

// ---- the route paths this router owns (for reconciliation/collision reporting) ----
export const ADDITIVE_ROUTES = [
  'GET /sports',
  'GET /matches/:id/highlights',
  'GET /matches/:id/share',
  'GET /matches/:id/broadcast',
  'POST /matches/:id/camera',
  'POST /matches/:id/tracked-events',
  'GET /leagues/:id/rankings',
  'GET /leagues/:id/certificates',
  'GET /leagues/:id/form',
  'GET /leagues/:id/athletes/:athleteId/form',
];

function allMemPerfs(league_id: string): MatchPerformance[] {
  const out: MatchPerformance[] = [];
  for (const m of db.matches.values()) {
    if (m.league_id !== league_id) continue;
    const st = db.matchState.get(m.id);
    if (st) out.push(...toPerformanceRows(st));
  }
  return out;
}

// ── multi-sport discovery ──
additiveRouter.get('/sports', h(async (_req, res) => {
  res.json({ sports: listSports().map((s) => ({ sport: s, scoring_model: scoringModelFor(s) })) });
}));

// ── auto-highlights (event-derived, counted) ──
additiveRouter.get('/matches/:id/highlights', h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const state = db.matchState.get(match.id);
  res.json(state ? buildHighlights(state) : { match_id: match.id, markers: [], top: [], generated_at: new Date().toISOString() });
}));

// ── shareable match page ──
additiveRouter.get('/matches/:id/share', h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const league = await repo.getLeague(match.league_id);
  const state = db.matchState.get(match.id);
  const perfs = state ? toPerformanceRows(state) : [];
  const innNo = state?.current_innings ?? 1;
  const inn = state?.innings?.[innNo];
  res.json({
    match_id: match.id,
    league: league ? { id: league.id, name: league.name, sport: league.sport } : null,
    status: match.status, result: match.result,
    home_team_id: match.home_team_id, away_team_id: match.away_team_id,
    score: inn ? { innings: innNo, runs: inn.total_runs, wickets: inn.total_wickets, over: inn.over, ball: inn.ball } : null,
    scorecard: state ? buildScorecard(match.id, perfs, dismissedFrom(state)) : { match_id: match.id, batting: [], bowling: [] },
    highlights: state ? buildHighlights(state).top : [],
    commentary: state ? buildCommentary(state, 15) : [],
    share_url: `https://sports.dcsai.ai/match/${match.id}`,
  });
}));

// ── smart-camera ingest ──
additiveRouter.post('/matches/:id/camera', requireScorer, h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const { venue, feed_url, source } = req.body ?? {};
  if (!feed_url) { res.status(400).json({ error: 'feed_url required' }); return; }
  const { feed, job } = await registerCameraFeed({ match_id: match.id, venue: venue ?? match.venue ?? 'unknown', feed_url, source });
  res.status(201).json({ ok: true, feed, tracking_job: job });
}));

// ── tracked events from CW15 → estimate-labeled highlights ──
additiveRouter.post('/matches/:id/tracked-events', requireScorer, h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const events: TrackedEvent[] = Array.isArray(req.body?.events) ? req.body.events : [];
  const highlights = ingestTrackedEvents(events.map((e) => ({ ...e, match_id: match.id })));
  const st = db.matchState.get(match.id);
  if (st) (st as unknown as { tracked_highlights?: unknown }).tracked_highlights = highlights;
  res.json({ ok: true, ingested: highlights.length, highlights });
}));

// ── broadcast page ──
additiveRouter.get('/matches/:id/broadcast', h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const league = await repo.getLeague(match.league_id);
  const state = db.matchState.get(match.id);
  const perfs = state ? toPerformanceRows(state) : [];
  const innNo = state?.current_innings ?? 1;
  const inn = state?.innings?.[innNo];
  const trackedHighlights = (state as unknown as { tracked_highlights?: unknown })?.tracked_highlights ?? [];
  res.json({
    match_id: match.id,
    league: league ? { id: league.id, name: league.name, sport: league.sport } : null,
    status: match.status, result: match.result,
    home_team_id: match.home_team_id, away_team_id: match.away_team_id,
    live: match.status !== 'completed',
    score: inn ? { innings: innNo, runs: inn.total_runs, wickets: inn.total_wickets, over: inn.over, ball: inn.ball } : null,
    recent: state ? state.events.slice(-6) : [],
    event_highlights: state ? buildHighlights(state).top : [],
    tracked_highlights: trackedHighlights,
    commentary: state ? buildCommentary(state, 20) : [],
    scorecard: state ? buildScorecard(match.id, perfs, dismissedFrom(state)) : { match_id: match.id, batting: [], bowling: [] },
    broadcast_url: `https://sports.dcsai.ai/broadcast/${match.id}`,
  });
}));

// ── rankings (counted) ──
additiveRouter.get('/leagues/:id/rankings', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const category = (req.query.category as RankingCategory) || 'runs';
  if (!['runs', 'wickets', 'catches', 'strike_rate'].includes(category)) { res.status(400).json({ error: 'bad category' }); return; }
  const perfs = await repo.performancesForLeague(league.id, () => allMemPerfs(league.id));
  res.json({ league_id: league.id, category, rankings: rankAthletes(league.sport, perfs, category) });
}));

// ── certificates (facts only) ──
additiveRouter.get('/leagues/:id/certificates', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const teams = await repo.teamsForLeague(league.id);
  const matches = await repo.matchesForLeague(league.id);
  const standings = computeStandings(league.sport, teams, matches, league.max_overs);
  const perfs = await repo.performancesForLeague(league.id, () => allMemPerfs(league.id));
  res.json({ league_id: league.id, certificates: buildCertificates(league.id, league.name, league.sport, standings, perfs) });
}));

// ── form analytics (CW13 feed) ──
additiveRouter.get('/leagues/:id/form', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const windowSize = Math.min(Math.max(Number(req.query.window ?? 5), 1), 20);
  const perfs = await repo.performancesForLeague(league.id, () => allMemPerfs(league.id));
  const matches = await repo.matchesForLeague(league.id);
  const order: Record<string, number> = {};
  [...matches].sort((a, b) => (a.date ? Date.parse(a.date) : 0) - (b.date ? Date.parse(b.date) : 0)).forEach((m, i) => { order[m.id] = i; });
  res.json({ league_id: league.id, window: windowSize, form: leagueForm(perfs, windowSize, order) });
}));

additiveRouter.get('/leagues/:id/athletes/:athleteId/form', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const windowSize = Math.min(Math.max(Number(req.query.window ?? 5), 1), 20);
  const all = await repo.performancesForLeague(league.id, () => allMemPerfs(league.id));
  const matches = await repo.matchesForLeague(league.id);
  const order: Record<string, number> = {};
  [...matches].sort((a, b) => (a.date ? Date.parse(a.date) : 0) - (b.date ? Date.parse(b.date) : 0)).forEach((m, i) => { order[m.id] = i; });
  const mine = all.filter((p) => p.athlete_id === req.params.athleteId).sort((x, y) => (order[x.match_id] ?? 0) - (order[y.match_id] ?? 0));
  if (mine.length === 0) { res.status(404).json({ error: 'no performances for athlete' }); return; }
  res.json({ league_id: league.id, form: computeForm(req.params.athleteId, mine, windowSize) });
}));
