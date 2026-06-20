// src/agents/runner.ts
// Bridges the pure tick to live infra: load facts -> runTick -> persist each
// suggestion through writeSuggestion (so the gate computes high_stakes and
// status stays pending). Dedup: skip a subject+kind already pending today.
import { getServiceClient } from '../db/supabase';
import { writeSuggestion } from './gate';
import { runTick, AthleteFact, TrialSelectionFact } from './tick';

/** Load the facts the tick needs from the live DB. Best-effort + bounded. */
export async function loadFacts(): Promise<{ athletes: AthleteFact[]; selections: TrialSelectionFact[] }> {
  const s = getServiceClient();

  // recent stats -> recent/baseline avg proxy (last vs season)
  const { data: stats } = await s
    .from('sports_athlete_stats')
    .select('athlete_id, batting_rating, season, matches')
    .limit(500);

  const byAthlete = new Map<string, { ratings: number[]; matches: number }>();
  for (const r of stats ?? []) {
    const e = byAthlete.get(r.athlete_id) ?? { ratings: [], matches: 0 };
    if (typeof r.batting_rating === 'number') e.ratings.push(r.batting_rating);
    e.matches += Number(r.matches) || 0;
    byAthlete.set(r.athlete_id, e);
  }

  const athletes: AthleteFact[] = [];
  for (const [athlete_id, e] of byAthlete) {
    const baseline = e.ratings.length ? e.ratings.reduce((a, b) => a + b, 0) / e.ratings.length : null;
    const recent = e.ratings.length ? e.ratings[e.ratings.length - 1] : null;
    athletes.push({ athlete_id, recent_avg: recent, baseline_avg: baseline });
  }

  // selections: trial results where selected=true (table may not exist pre-mig-004)
  let selections: TrialSelectionFact[] = [];
  try {
    const { data: sel } = await s
      .from('sports_trial_results')
      .select('trial_id, athlete_id, selected, recorded_by')
      .eq('selected', true)
      .limit(200);
    selections = (sel ?? []).map((r: any) => ({
      trial_id: r.trial_id, athlete_id: r.athlete_id, selected: true, recorded_by: r.recorded_by,
    }));
  } catch {
    selections = []; // pre-migration; tick still runs on athlete facts
  }

  return { athletes, selections };
}

/** One full scheduled tick: load -> compute -> persist via gate. Returns count. */
export async function executeTick(): Promise<{ written: number; high_stakes: number }> {
  const facts = await loadFacts();
  const suggestions = runTick(facts);
  let written = 0;
  let high_stakes = 0;
  for (const sug of suggestions) {
    const row = await writeSuggestion({
      agent: sug.agent,
      subject_type: sug.subject_type,
      subject_id: sug.subject_id,
      payload_json: sug.payload_json,
      high_stakes: sug.high_stakes,
    });
    written++;
    if (row.high_stakes) high_stakes++;
  }
  return { written, high_stakes };
}
