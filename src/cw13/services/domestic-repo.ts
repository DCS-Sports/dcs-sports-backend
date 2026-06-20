// CW13 — domestic/performance reads. Reads sports_match_performances +
// sports_athletes from the live `dcs-sports` Supabase. Service-role read here
// is acceptable: Domestic/Ranji + Selection Intelligence are verifier/admin and
// selection-committee surfaces gated by CW9 role middleware at the gateway —
// NOT public/anon. Public discovery goes through CW14's RLS-checked scout path.
// Mock fallback keeps tests/dev network-free.

import { svc, supabaseConfigured } from '../lib/supabase';
import { athletes, performances, type PerfFixture, type AthleteFixture } from '../mocks/store';

export interface PerfRow {
  athlete_id: string;
  season: string;
  match_id: string;
  runs: number;
  balls: number;
  wickets: number;
  // contextual signals; pressure_index supplied by match context when available
  venue: string;
  pressure_index: number;
}

export async function getAthlete(athleteId: string): Promise<{ id: string; name: string; state: string; dob?: string } | null> {
  if (!supabaseConfigured || !svc) {
    const a = athletes.get(athleteId);
    return a ? { id: a.id, name: a.name, state: a.state, dob: a.dob } : null;
  }
  const { data } = await svc
    .from('sports_athletes')
    .select('id, state, dob, user_id')
    .eq('id', athleteId)
    .single();
  if (!data) return null;
  return {
    id: data.id as string,
    name: (data as any).user_id ?? athleteId,
    state: (data.state as string) ?? '',
    dob: (data as any).dob ?? undefined,
  };
}

export async function getSeasonPerformances(athleteId: string, season: string): Promise<PerfRow[]> {
  const all = await getAllPerformances(athleteId);
  return all.filter((r) => r.season === season);
}

export async function getAllPerformances(athleteId: string): Promise<PerfRow[]> {
  if (!supabaseConfigured || !svc) {
    return performances
      .filter((p: PerfFixture) => p.athlete_id === athleteId)
      .map((p) => ({ ...p }));
  }
  const { data, error } = await svc
    .from('sports_match_performances')
    .select('athlete_id, match_id, runs, balls, wickets, sports_matches(date, venue)')
    .eq('athlete_id', athleteId);
  if (error) throw new Error('DB_PERF: ' + error.message);
  return (data ?? []).map((r: any) => ({
    athlete_id: r.athlete_id,
    match_id: r.match_id,
    runs: r.runs ?? 0,
    balls: r.balls ?? 0,
    wickets: r.wickets ?? 0,
    venue: r.sports_matches?.venue ?? '',
    season: deriveSeason(r.sports_matches?.date),
    pressure_index: 0.5,
  }));
}

// Indian domestic season convention: Apr–Mar => "YYYY-YY".
function deriveSeason(iso?: string): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 3 ? y : y - 1; // month 3 = April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
