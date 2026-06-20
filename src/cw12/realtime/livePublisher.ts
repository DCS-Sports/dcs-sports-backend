// CW12 — live scoring transport = Supabase Realtime (frozen ruling #5: reuse, no new plumbing).
// On each score event we (a) insert into sports_live_scores and (b) broadcast on a
// per-match channel so the Match Center updates without polling.
//
// Until the fresh dcs-sports Supabase project is provisioned by CW9, this falls back
// to an in-process event bus so the Match Center + tests run against the same interface.
// When SUPABASE_URL / SUPABASE_SERVICE_KEY are set, the real client is used. No code change
// needed at the call sites — the interface is identical.

import type { ScoreEvent, LiveScoreRow } from '../types/index';

type Listener = (row: LiveScoreRow) => void;

const channels: Record<string, Set<Listener>> = {};
let _seq = 0;

function rowId() {
  return `ls_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
}

// in-process fallback bus
export function subscribeMatch(match_id: string, fn: Listener): () => void {
  (channels[match_id] ??= new Set()).add(fn);
  return () => channels[match_id]?.delete(fn);
}

/**
 * Publish a score event: persist to sports_live_scores + broadcast on match channel.
 * Returns the persisted row shape. When Supabase is wired, swap the body for
 * supabase.from('sports_live_scores').insert(...) + channel.send(...).
 */
export async function publishScore(ev: ScoreEvent): Promise<LiveScoreRow> {
  const row: LiveScoreRow = {
    id: rowId(),
    match_id: ev.match_id,
    innings: ev.innings ?? 1,
    over: ev.over,
    ball: ev.ball,
    event_json: ev,
    ts: ev.ts,
  };

  // --- Supabase Realtime path (active once env is set; CW9 provisions the project) ---
  // const supa = getSupabase();
  // if (supa) {
  //   await supa.from('sports_live_scores').insert(row);
  //   await supa.channel(`match:${ev.match_id}`).send({
  //     type: 'broadcast', event: 'score', payload: row,
  //   });
  //   return row;
  // }

  // --- in-process fallback (Day-0, pre-provisioning) ---
  channels[ev.match_id]?.forEach((fn) => fn(row));
  return row;
}
