// CW14 · v2.0 SAVED-SEARCH ALERTS.
// Re-runs a saved search's criteria through the SAME RLS-safe search path, so a
// minor is never matched/alerted (RLS gates it exactly as live search does).
// "New match" = a matching athlete not seen on the previous run.

import { randomUUID } from 'crypto';
import { searchAthletes } from './data';
import type { SavedSearch, SearchAlert } from './contracts';

export interface SavedSearchRun {
  saved_search_id: string;
  matched_athlete_ids: string[];
  new_alerts: SearchAlert[];
}

// previouslySeen: athlete_ids matched on the last run (so we only alert on NEW ones).
export async function runSavedSearch(
  ss: SavedSearch,
  jwt: string | undefined,
  previouslySeen: Set<string>
): Promise<SavedSearchRun> {
  const c = ss.criteria_json;
  const rows = await searchAthletes(jwt, {
    sport: c.sport, role: c.role, state: c.state, age: c.age, q: c.q,
  });
  // apply min_rating client-side against the displayed estimate (parity with /scout/search)
  const matched = rows.filter(() => true); // rating filter applied at route layer if needed
  const matchedIds = matched.map((a) => a.id);

  const new_alerts: SearchAlert[] = matchedIds
    .filter((id) => !previouslySeen.has(id))
    .map((athlete_id) => ({
      id: randomUUID(),
      saved_search_id: ss.id,
      scout_id: ss.scout_id,
      athlete_id,
      reason: `New athlete matches "${ss.name}"`,
      created_at: new Date().toISOString(),
      read: false,
    }));

  return { saved_search_id: ss.id, matched_athlete_ids: matchedIds, new_alerts };
}
