// CW13 — Day-0 mock store. Stands in for the Supabase `sports_` tables until
// CW9's project is provisioned. Swapped for real Supabase client at integration.
// Tables touched by CW13: sports_verifications (owned),
// sports_athletes / sports_athlete_stats / sports_match_performances (read for
// domestic/selection — RLS-enforced at DB; here we just read the mock).

import type { VerificationRow } from '../lib/contracts';

export const verifications = new Map<string, VerificationRow>();

// minimal read-only athlete/perf fixtures for the domestic/selection endpoints
export interface AthleteFixture {
  id: string;
  name: string;
  sport: string;
  role: string;
  state: string;
  dob: string;
}

export interface PerfFixture {
  athlete_id: string;
  season: string;
  match_id: string;
  runs: number;
  balls: number;
  wickets: number;
  // contextual signals for selection intelligence
  venue: string;
  pressure_index: number; // 0..1, supplied by match context (mock)
}

export const athletes = new Map<string, AthleteFixture>([
  ['ath-1', { id: 'ath-1', name: 'R. Sharma', sport: 'cricket', role: 'batter', state: 'HR', dob: '2006-04-12' }],
  ['ath-2', { id: 'ath-2', name: 'A. Verma', sport: 'cricket', role: 'allrounder', state: 'HR', dob: '2004-09-01' }],
]);

export const performances: PerfFixture[] = [
  { athlete_id: 'ath-1', season: '2025-26', match_id: 'm1', runs: 78, balls: 54, wickets: 0, venue: 'Hisar', pressure_index: 0.7 },
  { athlete_id: 'ath-1', season: '2025-26', match_id: 'm2', runs: 41, balls: 33, wickets: 1, venue: 'Rohtak', pressure_index: 0.4 },
  { athlete_id: 'ath-1', season: '2025-26', match_id: 'm3', runs: 12, balls: 18, wickets: 0, venue: 'Hisar', pressure_index: 0.8 },
  { athlete_id: 'ath-1', season: '2025-26', match_id: 'm4', runs: 65, balls: 40, wickets: 0, venue: 'Karnal', pressure_index: 0.6 },
  { athlete_id: 'ath-1', season: '2024-25', match_id: 'm5', runs: 33, balls: 29, wickets: 2, venue: 'Delhi', pressure_index: 0.5 },
  { athlete_id: 'ath-1', season: '2024-25', match_id: 'm6', runs: 54, balls: 38, wickets: 0, venue: 'Hisar', pressure_index: 0.6 },
  { athlete_id: 'ath-2', season: '2025-26', match_id: 'm7', runs: 22, balls: 31, wickets: 3, venue: 'Hisar', pressure_index: 0.5 },
  { athlete_id: 'ath-2', season: '2025-26', match_id: 'm8', runs: 18, balls: 20, wickets: 1, venue: 'Rohtak', pressure_index: 0.4 },
];
