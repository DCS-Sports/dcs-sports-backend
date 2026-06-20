// CW12 — auto match-highlight stitching (v2.0). Derives a highlight reel from the
// scoring event log: boundaries, wickets, milestones (50s/100s), and key moments.
// Each marker carries the over.ball + a caption + an importance score, so:
//   (a) the shareable match page renders a highlights timeline, and
//   (b) CW15's video pipeline can cut clips on these timestamps (markerless tracking
//       finds the frame; CW12 says WHICH balls matter).
// Honest: this is event-derived, deterministic — NO AI, NO fabrication. CW15 owns the
// actual video frames; CW12 owns "which events are highlight-worthy" from real scoring.

import type { ScoreEvent } from '../types/index';
import type { MatchScoringState } from './scoringEngine';

export interface HighlightMarker {
  seq: number;          // position in the event log (stable handle)
  innings: number;
  over_ball: string;    // "12.4"
  kind: 'four' | 'six' | 'wicket' | 'milestone' | 'fast_scoring';
  caption: string;
  importance: number;   // 0..100 — for ranking / auto-reel length
  athlete_id: string;
}

export interface HighlightReel {
  match_id: string;
  markers: HighlightMarker[];     // chronological
  top: HighlightMarker[];         // importance-ranked (for a short auto-reel)
  generated_at: string;
}

const IMPORTANCE: Record<HighlightMarker['kind'], number> = {
  six: 70,
  four: 50,
  wicket: 85,
  milestone: 95,
  fast_scoring: 40,
};

/**
 * Build the highlight reel from a match's event log + running batter totals.
 * Milestones (50/100) are detected by tracking cumulative runs per batter as we replay.
 */
export function buildHighlights(state: MatchScoringState): HighlightReel {
  const markers: HighlightMarker[] = [];
  const runningRuns: Record<string, number> = {};
  let seq = 0;

  for (const ev of state.events) {
    seq += 1;
    const ob = `${ev.over}.${ev.ball}`;
    const inn = ev.innings ?? 1;

    if (ev.event === 'wicket') {
      markers.push({
        seq, innings: inn, over_ball: ob, kind: 'wicket',
        caption: `Wicket — ${ev.dismissed_id ?? 'batter'}${ev.bowler_id ? ` b ${ev.bowler_id}` : ''}`,
        importance: IMPORTANCE.wicket, athlete_id: ev.bowler_id ?? ev.athlete_id,
      });
      continue;
    }

    if (ev.event === 'run' || ev.event === 'dot') {
      const runs = ev.runs ?? 0;
      const prev = runningRuns[ev.athlete_id] ?? 0;
      const now = prev + runs;
      runningRuns[ev.athlete_id] = now;

      if (ev.boundary === 6 || runs === 6) {
        markers.push({ seq, innings: inn, over_ball: ob, kind: 'six', caption: `SIX — ${ev.athlete_id}`, importance: IMPORTANCE.six, athlete_id: ev.athlete_id });
      } else if (ev.boundary === 4 || runs === 4) {
        markers.push({ seq, innings: inn, over_ball: ob, kind: 'four', caption: `FOUR — ${ev.athlete_id}`, importance: IMPORTANCE.four, athlete_id: ev.athlete_id });
      }

      // milestone crossing (50, 100, 150…)
      const milestone = crossedMilestone(prev, now);
      if (milestone) {
        markers.push({
          seq, innings: inn, over_ball: ob, kind: 'milestone',
          caption: `${milestone} — ${ev.athlete_id}`, importance: IMPORTANCE.milestone, athlete_id: ev.athlete_id,
        });
      }
    }
  }

  const top = [...markers].sort((a, b) => b.importance - a.importance || a.seq - b.seq).slice(0, 10);
  return { match_id: state.match_id, markers, top, generated_at: new Date().toISOString() };
}

function crossedMilestone(prev: number, now: number): string | null {
  for (const m of [50, 100, 150, 200]) {
    if (prev < m && now >= m) return `${m}${m === 50 ? ' (fifty)' : ' (hundred)'}`;
  }
  return null;
}
