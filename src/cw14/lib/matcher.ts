// CW14 · v3.0 OPPORTUNITY MATCHER.
// Matches athletes to an opportunity's criteria via the SAME RLS-safe search path,
// so a minor is never matched/surfaced without a grant (RLS gates the candidate set).
// Match score is estimate-labeled (honest: it's a heuristic until CW15's model is LIVE).

import { randomUUID } from 'crypto';
import { searchAthletes } from './data';
import { estimate } from './honest_scope';
import type { Opportunity, OpportunityMatch, Athlete } from './contracts';

function ageOf(dob?: string | null): number | null {
  if (!dob) return null;
  const d = new Date(dob), n = new Date();
  let a = n.getFullYear() - d.getFullYear();
  const m = n.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--;
  return a;
}

// Heuristic match score in [0,1] from how well an athlete fits the criteria.
// Transparent + auditable weights — NOT a black box. Estimate-labeled downstream.
export function scoreAthlete(opp: Opportunity, a: Athlete): { score: number; reasons: string[] } {
  const c = opp.criteria_json || {};
  let pts = 0, max = 0;
  const reasons: string[] = [];

  if (c.sport) { max += 0.30; if (a.sport === c.sport) { pts += 0.30; reasons.push(`sport ${a.sport}`); } }
  if (c.role) { max += 0.25; if (a.role === c.role) { pts += 0.25; reasons.push(`role ${a.role}`); } }
  if (c.state) { max += 0.20; if (a.state === c.state) { pts += 0.20; reasons.push(`based in ${a.state}`); } }
  if (c.min_age != null || c.max_age != null) {
    max += 0.25;
    const age = ageOf(a.dob);
    if (age != null && (c.min_age == null || age >= c.min_age) && (c.max_age == null || age <= c.max_age)) {
      pts += 0.25; reasons.push(`age ${age} in range`);
    }
  }
  // if criteria are empty, give a neutral baseline so the matcher still surfaces something
  const score = max > 0 ? pts / max : 0.5;
  return { score: Math.round(score * 100) / 100, reasons };
}

// Build consented match candidates for an opportunity. jwt scopes the search to RLS.
// Only athletes the caller may see are considered → minors without grants never appear.
export async function matchOpportunity(
  opp: Opportunity,
  jwt: string | undefined,
  threshold = 0.6
): Promise<OpportunityMatch[]> {
  const candidates = await searchAthletes(jwt, {
    sport: opp.criteria_json?.sport,
    role: opp.criteria_json?.role,
    state: opp.criteria_json?.state,
  });
  const now = new Date().toISOString();
  return candidates
    .map((a) => ({ a, ...scoreAthlete(opp, a) }))
    .filter((m) => m.score >= threshold)
    .map((m) => ({
      id: randomUUID(),
      opportunity_id: opp.id,
      athlete_id: m.a.id,
      score: estimate<number>(m.score, Math.min(0.7, m.score), 'scout_ai', null),
      reason: m.reasons.length ? `Matches: ${m.reasons.join(', ')}` : 'Baseline match',
      consented: false,           // surfaced; needs athlete/guardian acceptance to act
      status: 'surfaced' as const,
      created_at: now,
    }));
}
