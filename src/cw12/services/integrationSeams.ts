// CW12 — cross-lane integration seams (Round 3).
// League OS is the data factory; these are the two places its data flows OUT to other lanes.
// Both are stub-and-flip: they write into the frozen S1 shared tables and are SAFE-by-default.
// They activate the moment CW15 (Vision) / CW14 (Trials) consume those tables — no code change here.
//
//   1. Match video -> CW15 Vision: enqueue a sports_vision_jobs row (status='queued').
//      CW15's BullMQ worker picks it up. Until CW15 ships, the row just sits queued (harmless).
//
//   2. League selection result -> CW14 Trials/Scout: write a sports_agent_suggestions row
//      (agent='league_selection', high_stakes=true) so a human selection still requires action.
//      CW14 owns the Athlete->Trial->Scout->Selection orchestration (ruling #11); CW12 only
//      emits the league-side fact. We do NOT reach into CW14's tables.
//
// Honest-scope: CW12 never decides a selection autonomously. It emits a suggestion;
// the high_stakes gate means a human acts. No AI here — these are facts + routing.

import { getSupabase } from '../db/supabase';

let _seq = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}_${(_seq++).toString(36)}`;

// ---------- Seam 1: match video -> Vision job (CW15) ----------
export interface VisionJobRequest {
  match_id: string;
  video_url: string;
  version?: string; // CW15 sets the model version; we default to v1 pipeline
}

export interface VisionJob {
  id: string;
  match_id: string;
  video_url: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  version: string;
}

/**
 * Enqueue a Vision job for a match's video. Idempotent-ish: callers should not enqueue
 * twice for the same (match_id, video_url) — CW15's worker dedupes on pickup.
 * Returns the queued job. If Supabase is absent (tests), returns the shaped row without persisting.
 */
export async function enqueueVisionJob(req: VisionJobRequest): Promise<VisionJob> {
  const job: VisionJob = {
    id: id('vj'),
    match_id: req.match_id,
    video_url: req.video_url,
    status: 'queued',
    version: req.version ?? 'v1',
  };
  const s = getSupabase();
  if (s) {
    let resp = await s.from('sports_vision_jobs').insert({
      id: job.id, match_id: job.match_id, video_url: job.video_url,
      status: job.status, version: job.version,
    });
    if (resp.error) throw new Error(`sports_vision_jobs insert: ${resp.error.message}`);
  }
  return job;
}

// ---------- Seam 2: league selection result -> Trials/Scout (CW14) ----------
export interface SelectionSignal {
  league_id: string;
  athlete_id: string;
  reason: string;          // e.g. "Top run scorer — Hisar T20 2026"
  selected_for?: string;   // e.g. a trial id / squad id (opaque to CW12)
  metric?: number;
}

export interface AgentSuggestion {
  id: string;
  agent: string;
  subject_type: string;
  subject_id: string;
  payload_json: Record<string, unknown>;
  high_stakes: boolean;
  status: 'pending' | 'actioned' | 'dismissed';
  created_at: string;
}

/**
 * Emit a league-side selection signal as a high-stakes agent suggestion.
 * CW14's trials/scout orchestration consumes sports_agent_suggestions where
 * agent='league_selection'. high_stakes=true => a human must action it (no auto-selection).
 */
export async function emitSelectionSignal(sig: SelectionSignal): Promise<AgentSuggestion> {
  const suggestion: AgentSuggestion = {
    id: id('as'),
    agent: 'league_selection',
    subject_type: 'athlete',
    subject_id: sig.athlete_id,
    payload_json: {
      league_id: sig.league_id,
      reason: sig.reason,
      selected_for: sig.selected_for ?? null,
      metric: sig.metric ?? null,
      source: 'league_os',
    },
    high_stakes: true,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  const s = getSupabase();
  if (s) {
    const resp = await s.from('sports_agent_suggestions').insert({
      id: suggestion.id, agent: suggestion.agent,
      subject_type: suggestion.subject_type, subject_id: suggestion.subject_id,
      payload_json: suggestion.payload_json, high_stakes: suggestion.high_stakes,
      status: suggestion.status, created_at: suggestion.created_at,
    });
    if (resp.error) throw new Error(`sports_agent_suggestions insert: ${resp.error.message}`);
  }
  return suggestion;
}
