// CW13 — Domestic/Ranji squad surface (module 4.9, the layer above the
// committee shortlist). A selector assembles a NAMED squad for a tournament/
// season from athlete ids (typically those a committee shortlisted).
//
// HARD RULES (honest-scope):
//   - A squad here is a SELECTION RECORD, not a roster write. It records who was
//     named, who named them, and when — as a human-actioned row on the FROZEN
//     sports_agent_suggestions table (no new schema, no DK sign-off).
//   - It performs NO write to CW12's teams/squads. Committing a squad to a live
//     roster is a separate CW12 + DK-gated step. This is the committee's record.
//   - "shortlisted" context is surfaced but not enforced — the selector is the
//     human authority and may name anyone; the record captures the decision.

import { randomUUID } from 'node:crypto';
import { writeSuggestion, listByAgent, type AgentSuggestion } from './agent-repo';
import { getAthlete } from './domestic-repo';

const AGENT = 'selection_committee';

export interface SquadMember {
  athlete_id: string;
  athlete_name: string;
  role: string | null; // e.g. 'captain' | 'vice_captain' | 'member'
}

export interface SquadRecord {
  squad_id: string;
  name: string;
  tournament: string;
  season: string;
  members: SquadMember[];
  selected_by: string;
  selected_at: string;
  effect: 'recorded_only';
}

// Name a squad. Resolves athlete names, records the squad as a human action.
export async function nameSquad(input: {
  name: string;
  tournament: string;
  season: string;
  members: { athlete_id: string; role?: string }[];
  selectedBy: string;
}): Promise<{ squad: SquadRecord; suggestion: AgentSuggestion }> {
  if (!input.selectedBy) throw new Error('HUMAN_REQUIRED: a selector id is required to name a squad');
  if (!input.name || !input.members?.length) throw new Error('SQUAD_INVALID: name + at least one member required');

  const members: SquadMember[] = [];
  for (const m of input.members) {
    const ath = await getAthlete(m.athlete_id);
    members.push({
      athlete_id: m.athlete_id,
      athlete_name: ath?.name ?? m.athlete_id,
      role: m.role ?? 'member',
    });
  }

  const squad: SquadRecord = {
    squad_id: cryptoId(),
    name: input.name,
    tournament: input.tournament,
    season: input.season,
    members,
    selected_by: input.selectedBy,
    selected_at: new Date().toISOString(),
    effect: 'recorded_only',
  };

  const suggestion = await writeSuggestion({
    agent: AGENT,
    subject_type: 'squad',
    subject_id: squad.squad_id,
    high_stakes: true,
    status: 'actioned', // a human named it
    payload_json: { kind: 'squad', ...squad },
  });

  return { squad, suggestion };
}

// List squads recorded for a tournament/season (committee/association view).
export async function listSquads(filter?: { tournament?: string; season?: string }): Promise<SquadRecord[]> {
  const rows = await listByAgent(AGENT);
  return rows
    .filter((r) => (r.payload_json as any)?.kind === 'squad')
    .map((r) => r.payload_json as unknown as SquadRecord)
    .filter((s) => (!filter?.tournament || s.tournament === filter.tournament) &&
                   (!filter?.season || s.season === filter.season))
    .sort((a, b) => a.selected_at.localeCompare(b.selected_at));
}

function cryptoId(): string {
  // squad ids are local record ids (not security-sensitive)
  return 'sq_' + randomUUID();
}
