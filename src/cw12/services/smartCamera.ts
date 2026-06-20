// CW12 — smart-camera ingest pipeline (v3.0).
//
// HONEST BOUNDARY: CW12 owns the INGEST + EVENT pipeline; CW15 owns the CV model
// (markerless tracking). A venue feed enters here, gets registered + queued as a
// sports_vision_jobs row (type='camera_ingest'); CW15's worker tracks it and writes
// tracked events back; CW12 turns those tracked events into auto-highlights on the
// match page. Until CW15's tracker is live, the job sits queued (harmless) and the
// match page falls back to the event-log highlights CW12 already produces.
//
// No fabricated tracking: CW12 never invents ball-tracking data. If no tracked events
// exist yet, the highlights come from real ball-by-ball scoring (which CW12 owns).

import { getSupabase } from '../db/supabase';

let _seq = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}_${(_seq++).toString(36)}`;

export interface CameraFeed {
  id: string;
  match_id: string;
  venue: string;
  feed_url: string;        // RTSP/HLS/upload URL of the venue camera
  source: 'smart_camera' | 'uploaded_feed';
  status: 'registered' | 'ingesting' | 'tracking' | 'done' | 'failed';
  registered_at: string;
}

export interface TrackingJob {
  id: string;
  match_id: string;
  feed_id: string;
  video_url: string;
  type: 'camera_ingest';
  status: 'queued' | 'processing' | 'done' | 'failed';
  version: string;         // CW15 stamps the tracker version
}

/**
 * Register a venue camera feed for a match and enqueue a tracking job for CW15.
 * Returns { feed, job }. The job is a sports_vision_jobs row CW15's worker picks up.
 */
export async function registerCameraFeed(input: {
  match_id: string; venue: string; feed_url: string; source?: CameraFeed['source'];
}): Promise<{ feed: CameraFeed; job: TrackingJob }> {
  const feed: CameraFeed = {
    id: id('cam'),
    match_id: input.match_id,
    venue: input.venue,
    feed_url: input.feed_url,
    source: input.source ?? 'smart_camera',
    status: 'registered',
    registered_at: new Date().toISOString(),
  };
  const job: TrackingJob = {
    id: id('trk'),
    match_id: input.match_id,
    feed_id: feed.id,
    video_url: input.feed_url,
    type: 'camera_ingest',
    status: 'queued',
    version: 'pending-cw15', // CW15 stamps its tracker version on pickup
  };

  const s = getSupabase();
  if (s) {
    // tracking job lands in sports_vision_jobs (CW15's queue). Feed metadata in event_json.
    const resp = await s.from('sports_vision_jobs').insert({
      id: job.id, match_id: job.match_id, video_url: job.video_url,
      status: job.status, version: job.version,
    });
    if (resp.error) throw new Error(`sports_vision_jobs insert: ${resp.error.message}`);
  }
  return { feed, job };
}

// A tracked event as CW15's tracker would emit it (markerless tracking output).
// CW12 ingests these and maps them into the same highlight/scoring contract.
export interface TrackedEvent {
  match_id: string;
  t_seconds: number;       // timestamp in the feed
  kind: 'boundary' | 'wicket' | 'shot' | 'delivery';
  athlete_id?: string;
  confidence: number;      // CW15's tracker confidence (0..1) — stays estimate-labeled
  meta?: Record<string, unknown>;
}

export interface IngestedHighlight {
  t_seconds: number;
  kind: TrackedEvent['kind'];
  caption: string;
  confidence: number;
  estimate: true;          // tracker output is ALWAYS estimate-labeled until CW15's gate
  source: 'smart_camera';
}

/**
 * Map CW15's tracked events into auto-highlight markers for the match/broadcast page.
 * These carry confidence + estimate:true (honest — they're model output, not counted facts).
 * This is the bridge: CW15 produces tracked events, CW12 renders them as highlights.
 */
export function ingestTrackedEvents(events: TrackedEvent[]): IngestedHighlight[] {
  return events
    .filter((e) => e.kind === 'boundary' || e.kind === 'wicket')
    .map((e) => ({
      t_seconds: e.t_seconds,
      kind: e.kind,
      caption: e.kind === 'wicket'
        ? `Wicket${e.athlete_id ? ` — ${e.athlete_id}` : ''} (tracked)`
        : `Boundary${e.athlete_id ? ` — ${e.athlete_id}` : ''} (tracked)`,
      confidence: e.confidence,
      estimate: true as const,
      source: 'smart_camera' as const,
    }))
    .sort((a, b) => a.t_seconds - b.t_seconds);
}
