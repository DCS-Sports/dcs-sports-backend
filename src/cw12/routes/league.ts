// CW12 — League OS routes. Implements the frozen S2 surface, now wired to the repo
// layer (Supabase when live, in-memory otherwise — routes don't know which).
//   POST /leagues
//   POST /leagues/:id/teams
//   POST /leagues/:id/fixtures/generate
//   POST /matches
//   POST /matches/:id/score          (ball-by-ball; emits the M-S1 contract event)
//   POST /matches/:id/close          (CW12 owns result computation — open Q1)
//   GET  /matches/:id/center
//   GET  /leagues/:id/standings
//   GET  /leagues/:id/leaderboard
//   POST /leagues/:id/knockout/advance

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { db } from '../db/store';
import * as repo from '../db/repo';
import { generateFixtures, generateKnockoutRound } from '../services/fixtureGenerator';
import {
  newMatchState, applyEvent, applyEventSafe, toPerformanceRows, ScoringError, buildInningsSummary,
} from '../services/scoringEngine';
import { computeStandings, computeLeaderboard } from '../services/standings';
import { rankAthletes, buildCertificates, type RankingCategory } from '../services/rankings';
import { publishScore } from '../realtime/livePublisher';
import { requireScorer } from '../middleware/requireScorer';
import { enqueueVisionJob, emitSelectionSignal } from '../services/integrationSeams';
import { leagueForm, computeForm } from '../services/formAnalytics';
import { buildCommentary, buildScorecard, dismissedFrom } from '../services/matchCenter';
import { buildHighlights } from '../services/highlights';
import { registerCameraFeed, ingestTrackedEvents } from '../services/smartCamera';
import type { TrackedEvent } from '../services/smartCamera';
import { listSports, scoringModelFor } from '../services/sportConfig';
import { newGenericState, applyGenericEvent, genericResult, GenericScoringError } from '../services/genericScorer';
import type { GenericScoreEvent, GenericMatchState } from '../services/genericScorer';
import type { Match, ScoreEvent, MatchPerformance, InningsTotals } from '../types/index';

export const leagueRouter = Router();

// async error wrapper (repo calls are async now)
const h = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// POST /leagues
leagueRouter.post('/leagues', h(async (req, res) => {
  const { name, organizer_user_id, format, level, season, sport = 'cricket', max_overs } = req.body ?? {};
  if (!name || !organizer_user_id || !format) {
    res.status(400).json({ error: 'name, organizer_user_id, format required' }); return;
  }
  const league = await repo.createLeague({
    name, organizer_user_id, format, level: level ?? null, season: season ?? null, sport,
    max_overs: max_overs ?? null,
  });
  res.status(201).json(league);
}));

// POST /leagues/:id/teams
leagueRouter.post('/leagues/:id/teams', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const { name, academy_id } = req.body ?? {};
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  const team = await repo.createTeam({ league_id: league.id, name, academy_id: academy_id ?? null });
  res.status(201).json(team);
}));

// POST /leagues/:id/fixtures/generate
leagueRouter.post('/leagues/:id/fixtures/generate', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const teams = await repo.teamsForLeague(league.id);
  if (teams.length < 2) { res.status(400).json({ error: 'need >= 2 teams' }); return; }

  const fixtures = generateFixtures({
    league_id: league.id,
    team_ids: teams.map((t) => t.id),
    format: league.format,
    double_round: !!req.body?.double_round,
  });
  await repo.saveFixtures(fixtures);
  res.status(201).json({ count: fixtures.length, fixtures });
}));

// POST /matches
leagueRouter.post('/matches', h(async (req, res) => {
  const { league_id, home_team_id, away_team_id, type = 'league', venue, date } = req.body ?? {};
  const league = await repo.getLeague(league_id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  if (!home_team_id || !away_team_id) { res.status(400).json({ error: 'both teams required' }); return; }
  const match = await repo.createMatch({
    league_id, type, home_team_id, away_team_id,
    venue: venue ?? null, date: date ?? null, status: 'live', result: null,
  });
  if (scoringModelFor(league.sport) === 'ball_by_ball') {
    db.matchState.set(match.id, newMatchState(match.id, league.sport));
  } else {
    db.genericState.set(match.id, newGenericState(match.id, league.sport));
  }
  res.status(201).json(match);
}));

// POST /matches/:id/score — ball-by-ball. Body = frozen S2 ScoreEvent.
leagueRouter.post('/matches/:id/score', requireScorer, h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const league = (await repo.getLeague(match.league_id))!;

  const ev: ScoreEvent = {
    ...req.body,
    match_id: match.id,
    ts: req.body?.ts ?? new Date().toISOString(),
  };
  if (!ev.athlete_id || !ev.event || ev.over == null || ev.ball == null) {
    res.status(400).json({ error: 'athlete_id, event, over, ball required' }); return;
  }

  let state = db.matchState.get(match.id);
  if (!state) { state = newMatchState(match.id, league.sport); db.matchState.set(match.id, state); }

  try {
    const outcome = applyEventSafe(state, ev, {
      idempotency_key: req.body?.idempotency_key,
      expected_seq: req.body?.expected_seq,
    });
    if (outcome.status === 'duplicate') {
      // safe no-op: a reconnecting scorer retried. Return current authoritative state.
      res.status(200).json({ ok: true, duplicate: true, seq: outcome.seq, performances: toPerformanceRows(state) });
      return;
    }
    if (outcome.status === 'conflict') {
      // a stale client (e.g. second scorer) — tell it to re-sync. 409 = re-fetch /center.
      res.status(409).json({ error: 'sequence conflict — re-sync', server_seq: outcome.seq, your_expected: outcome.expected });
      return;
    }
    const inn = outcome.innings;
    const liveRow = await publishScore(ev);     // Supabase Realtime broadcast (#5)
    await repo.insertLiveScore(liveRow);          // persist append-only event
    const perfs = toPerformanceRows(state);
    await repo.upsertPerformances(perfs);         // aggregate -> sports_match_performances
    const leaguePerfs = await repo.performancesForLeague(
      match.league_id, () => allMemPerfsForLeague(match.league_id),
    );
    res.json({
      ok: true,
      seq: outcome.seq,                             // client stores this as its new expected_seq
      innings: inn,
      performances: perfs,                          // CW10 reads these (source='match')
      leaderboard: computeLeaderboard(league.sport, leaguePerfs),
    });
  } catch (e) {
    if (e instanceof ScoringError) { res.status(422).json({ error: e.message }); return; }
    throw e;
  }
}));

// POST /matches/:id/close — CW12 owns result computation (open Q1, recommended path).
leagueRouter.post('/matches/:id/close', requireScorer, h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }

  const state = db.matchState.get(match.id);
  const genState = db.genericState.get(match.id);
  let result: string | null = req.body?.result ?? null;
  if (!result) {
    if (genState) {
      result = genericResult(genState);
    } else if (state) {
      result = decideResult(match, innTotals(state));
    } else {
      res.status(409).json({ error: 'no scoring state; pass explicit result' }); return;
    }
  }
  // build innings summary for NRR (cricket only)
  const summary = state
    ? buildInningsSummary(state, match.home_team_id, match.away_team_id)
    : null;
  await repo.updateMatchResult(match.id, 'completed', result, summary);
  res.json({ ok: true, match_id: match.id, status: 'completed', result, innings_summary: summary });
}));

// GET /matches/:id/center
leagueRouter.get('/matches/:id/center', h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const state = db.matchState.get(match.id);
  const perfs = state ? toPerformanceRows(state) : [];
  res.json({
    match,
    state: state ? { innings: state.innings, current_innings: state.current_innings } : null,
    seq: state ? state.seq : 0,
    performances: perfs,
    last_events: state ? state.events.slice(-12) : [],
    commentary: state ? buildCommentary(state, 30) : [],
    scorecard: state ? buildScorecard(match.id, perfs, dismissedFrom(state)) : { match_id: match.id, batting: [], bowling: [] },
  });
}));

// GET /matches/:id/scorecard — full batting + bowling card
leagueRouter.get('/matches/:id/scorecard', h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const state = db.matchState.get(match.id);
  const perfs = state ? toPerformanceRows(state) : [];
  res.json(buildScorecard(match.id, perfs, state ? dismissedFrom(state) : new Set()));
}));

// GET /matches/:id/commentary — most-recent-first feed
leagueRouter.get('/matches/:id/commentary', h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const state = db.matchState.get(match.id);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 30), 1), 100);
  res.json({ match_id: match.id, commentary: state ? buildCommentary(state, limit) : [] });
}));

// GET /matches/:id/highlights — auto-stitched highlight reel from live events (v2.0).
// Markers feed the shareable page + CW15's video cut points.
leagueRouter.get('/matches/:id/highlights', h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const state = db.matchState.get(match.id);
  res.json(state ? buildHighlights(state) : { match_id: match.id, markers: [], top: [], generated_at: new Date().toISOString() });
}));

// GET /matches/:id/share — shareable public match page view model (v2.0).
// Read-only, no auth. Returns only match-level data (scores, scorecard, highlights,
// commentary) — NO athlete PII beyond the ids that already appear in public scoring.
leagueRouter.get('/matches/:id/share', h(async (req, res) => {
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
    status: match.status,
    result: match.result,
    home_team_id: match.home_team_id,
    away_team_id: match.away_team_id,
    score: inn ? { innings: innNo, runs: inn.total_runs, wickets: inn.total_wickets, over: inn.over, ball: inn.ball } : null,
    scorecard: state ? buildScorecard(match.id, perfs, dismissedFrom(state)) : { match_id: match.id, batting: [], bowling: [] },
    highlights: state ? buildHighlights(state).top : [],
    commentary: state ? buildCommentary(state, 15) : [],
    share_url: `https://sports.dcsai.ai/match/${match.id}`,
  });
}));

// POST /matches/:id/camera — register a venue smart-camera/uploaded feed (v3.0).
// Enqueues a CW15 tracking job; returns the feed + job. Admin-gated.
leagueRouter.post('/matches/:id/camera', requireScorer, h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const { venue, feed_url, source } = req.body ?? {};
  if (!feed_url) { res.status(400).json({ error: 'feed_url required' }); return; }
  const { feed, job } = await registerCameraFeed({ match_id: match.id, venue: venue ?? match.venue ?? 'unknown', feed_url, source });
  res.status(201).json({ ok: true, feed, tracking_job: job, note: 'queued for CW15 markerless tracking; highlights fall back to event-log until tracked events arrive' });
}));

// POST /matches/:id/tracked-events — CW15's tracker posts tracked events back (v3.0).
// CW12 maps them to estimate-labeled auto-highlights for the match/broadcast page.
leagueRouter.post('/matches/:id/tracked-events', requireScorer, h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const events: TrackedEvent[] = Array.isArray(req.body?.events) ? req.body.events : [];
  const highlights = ingestTrackedEvents(events.map((e) => ({ ...e, match_id: match.id })));
  // store on the match state so the broadcast page can render them alongside event highlights
  const st = db.matchState.get(match.id);
  if (st) (st as unknown as { tracked_highlights?: unknown }).tracked_highlights = highlights;
  res.json({ ok: true, ingested: highlights.length, highlights });
}));

// GET /matches/:id/broadcast — live broadcast page view model (v3.0).
// Richer than /share: live score + over-track + auto-highlights (event + tracked) + commentary.
// Public, read-only. Tracked highlights carry estimate:true + confidence (honest).
leagueRouter.get('/matches/:id/broadcast', h(async (req, res) => {
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
    status: match.status,
    result: match.result,
    home_team_id: match.home_team_id,
    away_team_id: match.away_team_id,
    live: match.status !== 'completed',
    score: inn ? { innings: innNo, runs: inn.total_runs, wickets: inn.total_wickets, over: inn.over, ball: inn.ball } : null,
    recent: state ? state.events.slice(-6) : [],
    event_highlights: state ? buildHighlights(state).top : [],   // counted, from real scoring
    tracked_highlights: trackedHighlights,                        // estimate-labeled, from CW15 tracker
    commentary: state ? buildCommentary(state, 20) : [],
    scorecard: state ? buildScorecard(match.id, perfs, dismissedFrom(state)) : { match_id: match.id, batting: [], bowling: [] },
    broadcast_url: `https://sports.dcsai.ai/broadcast/${match.id}`,
  });
}));

// GET /leagues/:id/standings
leagueRouter.get('/leagues/:id/standings', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const teams = await repo.teamsForLeague(league.id);
  const matches = await repo.matchesForLeague(league.id);
  res.json({ league_id: league.id, standings: computeStandings(league.sport, teams, matches, league.max_overs) });
}));

// GET /leagues/:id/leaderboard
leagueRouter.get('/leagues/:id/leaderboard', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const perfs = await repo.performancesForLeague(league.id, () => allMemPerfsForLeague(league.id));
  res.json({ league_id: league.id, leaderboard: computeLeaderboard(league.sport, perfs) });
}));

// POST /leagues/:id/knockout/advance
leagueRouter.post('/leagues/:id/knockout/advance', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const { advancing, round } = req.body ?? {};
  if (!Array.isArray(advancing) || !round) { res.status(400).json({ error: 'advancing[], round required' }); return; }
  const fixtures = generateKnockoutRound(league.id, advancing, round);
  await repo.saveFixtures(fixtures);
  res.status(201).json({ count: fixtures.length, fixtures });
}));

// GET /sports — discovery: which sports are configured + their scoring model.
leagueRouter.get('/sports', h(async (_req, res) => {
  res.json({ sports: listSports().map((s) => ({ sport: s, scoring_model: scoringModelFor(s) })) });
}));

// POST /matches/:id/event — generic scoring for non-cricket sports (football/kabaddi/…).
// Cricket uses /score (ball-by-ball). This uses the period-points engine. Scorer-gated.
leagueRouter.post('/matches/:id/event', requireScorer, h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const league = (await repo.getLeague(match.league_id))!;
  if (scoringModelFor(league.sport) === 'ball_by_ball') {
    res.status(400).json({ error: 'this sport uses /score (ball-by-ball), not /event' }); return;
  }
  const ev: GenericScoreEvent = {
    ...req.body,
    match_id: match.id,
    ts: req.body?.ts ?? new Date().toISOString(),
  };
  if (!ev.athlete_id || !ev.team_id || !ev.event || ev.period == null) {
    res.status(400).json({ error: 'athlete_id, team_id, event, period required' }); return;
  }
  let state = db.genericState.get(match.id);
  if (!state) { state = newGenericState(match.id, league.sport); db.genericState.set(match.id, state); }
  try {
    applyGenericEvent(state, ev);
    res.json({
      ok: true,
      team_scores: state.team_scores,
      current_period: state.current_period,
      athletes: Object.values(state.athletes),
    });
  } catch (e) {
    if (e instanceof GenericScoringError) { res.status(422).json({ error: e.message }); return; }
    throw e;
  }
}));

// GET /matches/:id/event-center — read model for generic sports
leagueRouter.get('/matches/:id/event-center', h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const state = db.genericState.get(match.id);
  res.json({
    match,
    team_scores: state?.team_scores ?? {},
    period_scores: state?.period_scores ?? {},
    athletes: state ? Object.values(state.athletes) : [],
    last_events: state ? state.events.slice(-12) : [],
  });
}));

// GET /leagues/:id/rankings?category=runs|wickets|catches|strike_rate  (R2)
leagueRouter.get('/leagues/:id/rankings', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const category = (req.query.category as RankingCategory) || 'runs';
  const valid = ['runs', 'wickets', 'catches', 'strike_rate'];
  if (!valid.includes(category)) { res.status(400).json({ error: `category must be one of ${valid.join(', ')}` }); return; }
  const perfs = await repo.performancesForLeague(league.id, () => allMemPerfsForLeague(league.id));
  res.json({ league_id: league.id, category, rankings: rankAthletes(league.sport, perfs, category) });
}));

// GET /leagues/:id/certificates  (R2) — facts only, no fabrication
leagueRouter.get('/leagues/:id/certificates', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const teams = await repo.teamsForLeague(league.id);
  const matches = await repo.matchesForLeague(league.id);
  const standings = computeStandings(league.sport, teams, matches, league.max_overs);
  const perfs = await repo.performancesForLeague(league.id, () => allMemPerfsForLeague(league.id));
  const certs = buildCertificates(league.id, league.name, league.sport, standings, perfs);
  res.json({ league_id: league.id, certificates: certs });
}));

// POST /matches/:id/video — attach match video, enqueue CW15 Vision job (R3 seam).
// Stub-and-flip: writes sports_vision_jobs; CW15's worker activates it. Admin-gated.
leagueRouter.post('/matches/:id/video', requireScorer, h(async (req, res) => {
  const match = await repo.getMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }
  const { video_url, version } = req.body ?? {};
  if (!video_url) { res.status(400).json({ error: 'video_url required' }); return; }
  const job = await enqueueVisionJob({ match_id: match.id, video_url, version });
  res.status(201).json({ ok: true, vision_job: job, note: 'queued for CW15 Vision pipeline' });
}));

// POST /leagues/:id/select — emit a high-stakes selection signal for CW14 (R3 seam).
// Body: { athlete_id, reason, selected_for?, metric? }. Human-action gated downstream.
leagueRouter.post('/leagues/:id/select', requireScorer, h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const { athlete_id, reason, selected_for, metric } = req.body ?? {};
  if (!athlete_id || !reason) { res.status(400).json({ error: 'athlete_id, reason required' }); return; }
  const suggestion = await emitSelectionSignal({ league_id: league.id, athlete_id, reason, selected_for, metric });
  res.status(201).json({ ok: true, suggestion, note: 'high_stakes — requires human action in CW14' });
}));

// POST /leagues/:id/select/auto — emit selection signals for the league's top performers.
// Convenience: turns league leaders into pending selection suggestions (still human-gated).
leagueRouter.post('/leagues/:id/select/auto', requireScorer, h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const topN = Math.min(Number(req.body?.top_n ?? 3), 10);
  const perfs = await repo.performancesForLeague(league.id, () => allMemPerfsForLeague(league.id));
  const byRuns = rankAthletes(league.sport, perfs, 'runs').slice(0, topN).filter((r) => r.metric > 0);
  const signals = [];
  for (const r of byRuns) {
    signals.push(await emitSelectionSignal({
      league_id: league.id, athlete_id: r.athlete_id,
      reason: `Top ${r.rank} run scorer — ${league.name}`, metric: r.metric,
    }));
  }
  res.status(201).json({ ok: true, count: signals.length, suggestions: signals, note: 'all high_stakes — human-gated in CW14' });
}));

// GET /leagues/:id/form?window=5  — per-athlete form/consistency (R4 feed for CW13).
// Counted facts only (no estimate). CW13 layers Selection Intelligence on top of these.
leagueRouter.get('/leagues/:id/form', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const windowSize = Math.min(Math.max(Number(req.query.window ?? 5), 1), 20);
  const perfs = await repo.performancesForLeague(league.id, () => allMemPerfsForLeague(league.id));
  const order = await matchOrderForLeague(league.id);
  res.json({ league_id: league.id, window: windowSize, form: leagueForm(perfs, windowSize, order) });
}));

// GET /leagues/:id/athletes/:athleteId/form?window=5  — one athlete's form.
leagueRouter.get('/leagues/:id/athletes/:athleteId/form', h(async (req, res) => {
  const league = await repo.getLeague(req.params.id);
  if (!league) { res.status(404).json({ error: 'league not found' }); return; }
  const windowSize = Math.min(Math.max(Number(req.query.window ?? 5), 1), 20);
  const all = await repo.performancesForLeague(league.id, () => allMemPerfsForLeague(league.id));
  const order = await matchOrderForLeague(league.id);
  const mine = all
    .filter((p) => p.athlete_id === req.params.athleteId)
    .sort((x, y) => (order[x.match_id] ?? 0) - (order[y.match_id] ?? 0));
  if (mine.length === 0) { res.status(404).json({ error: 'no performances for athlete in this league' }); return; }
  res.json({ league_id: league.id, form: computeForm(req.params.athleteId, mine, windowSize) });
}));

// ---- helpers ----

// build match_id -> sequence index for chronological form ordering.
// Orders by match.date when present, else stable insertion order.
async function matchOrderForLeague(league_id: string): Promise<Record<string, number>> {
  const matches = await repo.matchesForLeague(league_id);
  const sorted = [...matches].sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : 0;
    const dbb = b.date ? Date.parse(b.date) : 0;
    return da - dbb;
  });
  const order: Record<string, number> = {};
  sorted.forEach((m, i) => { order[m.id] = i; });
  return order;
}

function allMemPerfsForLeague(league_id: string): MatchPerformance[] {
  const out: MatchPerformance[] = [];
  for (const m of db.matches.values()) {
    if (m.league_id !== league_id) continue;
    const st = db.matchState.get(m.id);
    if (st) out.push(...toPerformanceRows(st));
  }
  return out;
}

function innTotals(state: { innings: Record<number, { total_runs: number; total_wickets: number }> }): InningsTotals[] {
  return Object.entries(state.innings).map(([n, v]) => ({
    innings: Number(n), runs: v.total_runs, wickets: v.total_wickets,
  }));
}

// innings 1 = home batting, innings 2 = away batting (scorer sets innings).
function decideResult(match: Match, totals: InningsTotals[]): string {
  const i1 = totals.find((t) => t.innings === 1);
  const i2 = totals.find((t) => t.innings === 2);
  if (!i1 || !i2) return 'no_result';
  if (i1.runs > i2.runs) return match.home_team_id;
  if (i2.runs > i1.runs) return match.away_team_id;
  return 'tie';
}
