// CW13 — Selection Committee surface (module 4.9, the consumer of Selection
// Intelligence). Ranks a candidate POOL by the estimate-labeled selection signal
// and records the committee's HUMAN decision (shortlist / hold / pass).
//
// HARD RULES (honest-scope):
//   - Ranking is advisory + estimate-labeled. It orders candidates; it does NOT
//     select anyone. The committee decides.
//   - A decision is a HUMAN action (carries decided_by). It is recorded as a
//     human-actioned row in sports_agent_suggestions (the FROZEN S1 table) —
//     CW13 invents NO new schema. status:'actioned', high_stakes:true.
//   - No squad/roster write happens here. Moving a player into a squad is a
//     separate, DK/committee-gated step on CW12's side.

import { domesticSeason } from './domestic';
import { writeSuggestion, type AgentSuggestion } from './agent-repo';
import type { EstimateEnvelope } from '../lib/contracts';

export type Verdict = 'shortlist' | 'hold' | 'pass';

export interface RankedCandidate {
  rank: number;
  athlete_id: string;
  athlete_name: string;
  season: string;
  runs: number;
  matches: number;
  high_score: number;
  signal: EstimateEnvelope;   // estimate-labeled — ordering basis, not a verdict
}

export interface Shortlist {
  season: string;
  pool_size: number;
  ranked: RankedCandidate[];
  note: string;               // honest-scope reminder rendered to the committee
}

// Rank a pool of athlete ids for a season by their selection signal.
export async function rankPool(athleteIds: string[], season: string): Promise<Shortlist> {
  const summaries = await Promise.all(
    athleteIds.map(async (id) => {
      try {
        return await domesticSeason(id, season);
      } catch {
        return null; // skip unknown / no-data athletes rather than fail the whole pool
      }
    })
  );

  const ranked: RankedCandidate[] = summaries
    .filter((s): s is NonNullable<typeof s> => s != null)
    .sort((a, b) => b.selection_signal.value - a.selection_signal.value)
    .map((s, i) => ({
      rank: i + 1,
      athlete_id: s.athlete_id,
      athlete_name: s.athlete_name,
      season: s.season,
      runs: s.runs,
      matches: s.matches,
      high_score: s.high_score,
      signal: s.selection_signal,
    }));

  return {
    season,
    pool_size: athleteIds.length,
    ranked,
    note: 'Ranking is an estimate to inform the committee — it is not a selection. Every decision below is recorded as a human action.',
  };
}

// Record a committee decision as a human-actioned suggestion on the frozen
// sports_agent_suggestions table. Requires decided_by (a human committee member).
export async function recordDecision(
  athleteId: string,
  season: string,
  verdict: Verdict,
  decidedBy: string,
  rationale?: string
): Promise<AgentSuggestion> {
  if (!decidedBy) throw new Error('HUMAN_REQUIRED: a committee member id is required to record a decision');
  return writeSuggestion({
    agent: 'selection_committee',
    subject_type: 'athlete',
    subject_id: athleteId,
    high_stakes: true,
    status: 'actioned',           // a human acted — not an open AI suggestion
    payload_json: {
      kind: 'committee_decision',
      season,
      verdict,
      decided_by: decidedBy,
      rationale: rationale ?? null,
      decided_at: new Date().toISOString(),
      // explicit: no roster mutation performed here
      effect: 'recorded_only',
    },
  });
}
