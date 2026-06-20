// CW12 — fixture generator.
// Sport-agnostic: operates only on team ids + format. No cricket assumptions.
// Endpoint: POST /leagues/:id/fixtures/generate

import type { Fixture, LeagueFormat } from '../types/index';

let _seq = 0;
const fid = () => `fx_${Date.now().toString(36)}_${(_seq++).toString(36)}`;

interface GenInput {
  league_id: string;
  team_ids: string[];
  format: LeagueFormat;
  double_round?: boolean; // round-robin home+away
}

/**
 * Round-robin via the circle method.
 * If team count is odd, a virtual "bye" slot is inserted (away_team_id = null).
 * Produces (n-1) rounds for even n, n rounds for odd n.
 */
export function roundRobin(league_id: string, team_ids: string[], double = false): Fixture[] {
  const teams = [...team_ids];
  const hasBye = teams.length % 2 !== 0;
  if (hasBye) teams.push('__BYE__');

  const n = teams.length;
  const rounds = n - 1;
  const half = n / 2;
  const fixtures: Fixture[] = [];

  // fixed[0], rotating rest
  const arr = [...teams];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < half; i++) {
      const home = arr[i];
      const away = arr[n - 1 - i];
      if (home !== '__BYE__' && away !== '__BYE__') {
        fixtures.push(mk(league_id, r + 1, home, away));
      } else {
        // record the bye so standings can credit no-result/walkover correctly
        const real = home === '__BYE__' ? away : home;
        fixtures.push(mk(league_id, r + 1, real, null));
      }
    }
    // rotate: keep arr[0] fixed, rotate the rest clockwise
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop()!);
    arr.splice(0, arr.length, fixed, ...rest);
  }

  if (double) {
    const second = fixtures.map((f) =>
      mk(f.league_id, f.round + rounds, f.away_team_id ?? f.home_team_id, f.away_team_id ? f.home_team_id : null),
    );
    return [...fixtures, ...second];
  }
  return fixtures;
}

/**
 * Single-elimination bracket. Pads to the next power of two with byes
 * so the bracket is balanced; byes auto-advance (away_team_id = null).
 * Only round 1 is generated up-front; later rounds are created as results land
 * (winners aren't known yet). Returns round-1 fixtures.
 */
export function knockout(league_id: string, team_ids: string[]): Fixture[] {
  const teams = [...team_ids];
  if (teams.length < 2) return [];
  const size = nextPow2(teams.length);
  const byes = size - teams.length;

  // standard seeding: spread byes across top seeds
  const seeded: (string | null)[] = [...teams];
  for (let i = 0; i < byes; i++) seeded.push(null);

  const fixtures: Fixture[] = [];
  for (let i = 0; i < size / 2; i++) {
    const home = seeded[i] as string;
    const away = seeded[size - 1 - i];
    fixtures.push(mk(league_id, 1, home, away)); // away null = bye, home auto-advances
  }
  return fixtures;
}

/**
 * Hybrid: round-robin group stage, then a knockout seam.
 * Generates the group stage now; the knockout round is generated from standings
 * once the group stage completes (via generateKnockoutRound).
 */
export function hybrid(league_id: string, team_ids: string[], double = false): Fixture[] {
  return roundRobin(league_id, team_ids, double);
}

/** Generate the next knockout round from a list of advancing team ids (in seed order). */
export function generateKnockoutRound(league_id: string, advancing: string[], round: number): Fixture[] {
  const fixtures: Fixture[] = [];
  for (let i = 0; i < Math.floor(advancing.length / 2); i++) {
    fixtures.push(mk(league_id, round, advancing[i * 2], advancing[i * 2 + 1]));
  }
  if (advancing.length % 2 === 1) {
    fixtures.push(mk(league_id, round, advancing[advancing.length - 1], null)); // odd -> bye
  }
  return fixtures;
}

export function generateFixtures(input: GenInput): Fixture[] {
  const { league_id, team_ids, format, double_round } = input;
  if (team_ids.length < 2) return [];
  switch (format) {
    case 'round_robin':
      return roundRobin(league_id, team_ids, !!double_round);
    case 'knockout':
      return knockout(league_id, team_ids);
    case 'hybrid':
      return hybrid(league_id, team_ids, !!double_round);
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

function mk(league_id: string, round: number, home: string, away: string | null): Fixture {
  return {
    id: fid(),
    league_id,
    round,
    home_team_id: home,
    away_team_id: away,
    venue: null,
    scheduled_at: null,
  };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
