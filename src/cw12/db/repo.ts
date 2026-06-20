// CW12 — repository (data-access). One interface, two backends:
//   - Supabase (service role) when SUPABASE_URL + SERVICE_ROLE_KEY are set
//   - in-memory store otherwise (tests, pre-provision)
// Routes/services never know which backend is active.
//
// Column shapes are taken 1:1 from the live S1 schema (sports_* tables).
// We write match_performances (source='match') and live_scores from this lane.

import { getSupabase } from './supabase';
import { db, newId, teamsForLeague as memTeams, matchesForLeague as memMatches } from './store';
import type {
  League, Team, Fixture, Match, LiveScoreRow, MatchPerformance, ScoreEvent, MatchInningsSummary,
} from '../types/index';

const live = () => getSupabase();

// ---------- leagues ----------
export async function createLeague(l: Omit<League, 'id'>): Promise<League> {
  const s = live();
  const row: League = { id: newId('lg'), ...l };
  if (s) {
    const base = {
      id: row.id, name: row.name, organizer_user_id: row.organizer_user_id,
      format: row.format, level: row.level, season: row.season, sport: row.sport,
    };
    // max_overs is an additive column (CW9 schema flag, OPEN_QUESTIONS Q6).
    // Try with it; if the column doesn't exist yet, retry without — never block a create.
    let resp = await s.from('sports_leagues').insert({ ...base, max_overs: row.max_overs ?? null }).select().single();
    if (resp.error && /max_overs/.test(resp.error.message)) {
      resp = await s.from('sports_leagues').insert(base).select().single();
    }
    if (resp.error) throw new Error(`sports_leagues insert: ${resp.error.message}`);
    return resp.data as League;
  }
  db.leagues.set(row.id, row);
  return row;
}

export async function getLeague(id: string): Promise<League | null> {
  const s = live();
  if (s) {
    const { data, error } = await s.from('sports_leagues').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`sports_leagues read: ${error.message}`);
    return (data as League) ?? null;
  }
  return db.leagues.get(id) ?? null;
}

// ---------- teams ----------
export async function createTeam(t: Omit<Team, 'id'>): Promise<Team> {
  const s = live();
  const row: Team = { id: newId('tm'), ...t };
  if (s) {
    const { data, error } = await s.from('sports_teams').insert({
      id: row.id, league_id: row.league_id, name: row.name, academy_id: row.academy_id,
    }).select().single();
    if (error) throw new Error(`sports_teams insert: ${error.message}`);
    return data as Team;
  }
  db.teams.set(row.id, row);
  return row;
}

export async function teamsForLeague(league_id: string): Promise<{ id: string; name: string }[]> {
  const s = live();
  if (s) {
    const { data, error } = await s.from('sports_teams').select('id,name').eq('league_id', league_id);
    if (error) throw new Error(`sports_teams list: ${error.message}`);
    return (data ?? []) as { id: string; name: string }[];
  }
  return memTeams(league_id);
}

// ---------- fixtures ----------
export async function saveFixtures(fixtures: Fixture[]): Promise<void> {
  const s = live();
  if (s) {
    if (fixtures.length === 0) return;
    const { error } = await s.from('sports_fixtures').insert(
      fixtures.map((f) => ({
        id: f.id, league_id: f.league_id, round: f.round,
        home_team_id: f.home_team_id, away_team_id: f.away_team_id,
        venue: f.venue, scheduled_at: f.scheduled_at,
      })),
    );
    if (error) throw new Error(`sports_fixtures insert: ${error.message}`);
    return;
  }
  fixtures.forEach((f) => db.fixtures.set(f.id, f));
}

// ---------- matches ----------
export async function createMatch(m: Omit<Match, 'id'>): Promise<Match> {
  const s = live();
  const row: Match = { id: newId('mt'), ...m };
  if (s) {
    const { data, error } = await s.from('sports_matches').insert({
      id: row.id, league_id: row.league_id, type: row.type,
      home_team_id: row.home_team_id, away_team_id: row.away_team_id,
      venue: row.venue, date: row.date, status: row.status, result: row.result,
    }).select().single();
    if (error) throw new Error(`sports_matches insert: ${error.message}`);
    return data as Match;
  }
  db.matches.set(row.id, row);
  return row;
}

export async function getMatch(id: string): Promise<Match | null> {
  const s = live();
  if (s) {
    const { data, error } = await s.from('sports_matches').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`sports_matches read: ${error.message}`);
    return (data as Match) ?? null;
  }
  return db.matches.get(id) ?? null;
}

export async function updateMatchResult(
  id: string,
  status: Match['status'],
  result: string | null,
  innings_summary?: MatchInningsSummary[] | null,
): Promise<void> {
  const s = live();
  if (s) {
    const patch: Record<string, unknown> = { status, result };
    if (innings_summary !== undefined) patch.innings_summary = innings_summary;
    let resp = await s.from('sports_matches').update(patch).eq('id', id);
    // innings_summary is additive (CW9 schema flag); retry without it if absent.
    if (resp.error && /innings_summary/.test(resp.error.message)) {
      resp = await s.from('sports_matches').update({ status, result }).eq('id', id);
    }
    if (resp.error) throw new Error(`sports_matches update: ${resp.error.message}`);
    return;
  }
  const m = db.matches.get(id);
  if (m) { m.status = status; m.result = result; if (innings_summary !== undefined) m.innings_summary = innings_summary; }
}

export async function matchesForLeague(league_id: string): Promise<Match[]> {
  const s = live();
  if (s) {
    const { data, error } = await s.from('sports_matches').select('*').eq('league_id', league_id);
    if (error) throw new Error(`sports_matches list: ${error.message}`);
    return (data ?? []) as Match[];
  }
  return memMatches(league_id);
}

// ---------- live scores (append-only) ----------
export async function insertLiveScore(row: LiveScoreRow): Promise<void> {
  const s = live();
  if (s) {
    const { error } = await s.from('sports_live_scores').insert({
      id: row.id, match_id: row.match_id, innings: row.innings,
      over: row.over, ball: row.ball, event_json: row.event_json, ts: row.ts,
    });
    if (error) throw new Error(`sports_live_scores insert: ${error.message}`);
  }
  // in-memory: the score event log lives inside matchState; nothing extra to do.
}

// ---------- match_performances (the aggregate CW10/CW14 read; source='match') ----------
// Upsert on (match_id, athlete_id): the engine recomputes the full aggregate each event,
// so we overwrite — last-write-wins, and replay is idempotent.
export async function upsertPerformances(rows: MatchPerformance[]): Promise<void> {
  const s = live();
  if (s) {
    if (rows.length === 0) return;
    const { error } = await s.from('sports_match_performances')
      .upsert(
        rows.map((r) => ({
          match_id: r.match_id, athlete_id: r.athlete_id,
          runs: r.runs, balls: r.balls, fours: r.fours, sixes: r.sixes,
          overs: r.overs, wickets: r.wickets, runs_conceded: r.runs_conceded,
          catches: r.catches, source: 'match',
        })),
        { onConflict: 'match_id,athlete_id' },
      );
    if (error) throw new Error(`sports_match_performances upsert: ${error.message}`);
  }
  // in-memory: performances live in matchState; routes read them from there.
}

export async function performancesForLeague(league_id: string, fallback: () => MatchPerformance[]): Promise<MatchPerformance[]> {
  const s = live();
  if (s) {
    const ms = await matchesForLeague(league_id);
    const ids = ms.map((m) => m.id);
    if (ids.length === 0) return [];
    const { data, error } = await s.from('sports_match_performances').select('*').in('match_id', ids);
    if (error) throw new Error(`sports_match_performances list: ${error.message}`);
    return (data ?? []) as MatchPerformance[];
  }
  return fallback();
}
