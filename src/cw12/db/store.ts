// CW12 — mock store. Stands in for the sports_ tables until CW9 provisions the
// fresh dcs-sports Supabase project. Same shapes as S1, so swapping in the real
// Supabase client is a data-access change only — routes/services don't change.

import type { League, Team, Fixture, Match } from '../types/index';
import type { MatchScoringState } from '../services/scoringEngine';

export const db = {
  leagues: new Map<string, League>(),
  teams: new Map<string, Team>(),
  teamPlayers: [] as { team_id: string; athlete_id: string }[],
  fixtures: new Map<string, Fixture>(),
  matches: new Map<string, Match>(),
  // live scoring state per match (rebuildable via replay)
  matchState: new Map<string, MatchScoringState>(),
  // generic (non-cricket) match state per match
  genericState: new Map<string, import('../services/genericScorer.js').GenericMatchState>(),
};

let _seq = 0;
export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${(_seq++).toString(36)}`;

export function teamsForLeague(league_id: string): { id: string; name: string }[] {
  return [...db.teams.values()]
    .filter((t) => t.league_id === league_id)
    .map((t) => ({ id: t.id, name: t.name }));
}

export function matchesForLeague(league_id: string): Match[] {
  return [...db.matches.values()].filter((m) => m.league_id === league_id);
}
