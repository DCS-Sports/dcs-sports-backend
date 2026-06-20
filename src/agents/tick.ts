// src/agents/tick.ts
// Scheduled Autonomous Agent Layer (4.17). Pure scan logic: given DB facts,
// produce suggestions. The scheduler (worker.ts) fetches facts + persists via
// the gate (writeSuggestion), so high-stakes rows stay pending + human-gated.
// No LLM here — these are deterministic, explainable triggers. Real model
// intelligence flips in later when DK provisions an LLM (#10); the seam is ready.
import { AgentSuggestion } from '../types';

export interface AthleteFact {
  athlete_id: string;
  next_match_at?: string | null;   // ISO
  recent_avg?: number | null;
  baseline_avg?: number | null;
  last_active_days?: number | null; // days since last attendance/match
}

export interface TrialSelectionFact {
  trial_id: string;
  athlete_id: string;
  selected: boolean;
  recorded_by: string;
}

type NewSuggestion = Omit<AgentSuggestion, 'id' | 'created_at'>;

const PERF_DROP = 0.15;       // 15% relative drop
const INACTIVE_DAYS = 14;     // dormant athlete nudge
const MATCH_SOON_HRS = 48;    // prep window

/** athlete_agent: low-stakes nudges (match prep, re-engagement). */
export function athleteAgentScan(facts: AthleteFact[], now = new Date()): NewSuggestion[] {
  const out: NewSuggestion[] = [];
  for (const f of facts) {
    if (f.next_match_at) {
      const hrs = (new Date(f.next_match_at).getTime() - now.getTime()) / 3_600_000;
      if (hrs > 0 && hrs <= MATCH_SOON_HRS) {
        out.push({
          agent: 'athlete_agent',
          subject_type: 'reminder',
          subject_id: f.athlete_id,
          payload_json: { kind: 'match_prep', hours_until: Math.round(hrs) },
          high_stakes: false,
          status: 'pending',
        });
      }
    }
    if (typeof f.last_active_days === 'number' && f.last_active_days >= INACTIVE_DAYS) {
      out.push({
        agent: 'athlete_agent',
        subject_type: 'reminder',
        subject_id: f.athlete_id,
        payload_json: { kind: 're_engage', inactive_days: f.last_active_days },
        high_stakes: false,
        status: 'pending',
      });
    }
  }
  return out;
}

/** coach_agent: flags form drops for coach review (low-stakes advisory). */
export function coachAgentScan(facts: AthleteFact[]): NewSuggestion[] {
  const out: NewSuggestion[] = [];
  for (const f of facts) {
    if (
      typeof f.recent_avg === 'number' &&
      typeof f.baseline_avg === 'number' &&
      f.baseline_avg > 0 &&
      (f.baseline_avg - f.recent_avg) / f.baseline_avg >= PERF_DROP
    ) {
      out.push({
        agent: 'coach_agent',
        subject_type: 'review',
        subject_id: f.athlete_id,
        payload_json: {
          kind: 'form_drop',
          recent_avg: f.recent_avg,
          baseline_avg: f.baseline_avg,
          drop_pct: Number(((f.baseline_avg - f.recent_avg) / f.baseline_avg).toFixed(2)),
        },
        high_stakes: false,
        status: 'pending',
      });
    }
  }
  return out;
}

/** scout_agent: a recorded selection is HIGH-STAKES — pending, human-gated. */
export function scoutAgentScan(selections: TrialSelectionFact[]): NewSuggestion[] {
  return selections
    .filter((s) => s.selected)
    .map((s) => ({
      agent: 'scout_agent' as const,
      subject_type: 'selection',     // gate forces high_stakes
      subject_id: s.athlete_id,
      payload_json: { trial_id: s.trial_id, recorded_by: s.recorded_by },
      high_stakes: true,
      status: 'pending' as const,
    }));
}

export interface TickInput {
  athletes: AthleteFact[];
  selections: TrialSelectionFact[];
  now?: Date;
}

/** Compose all agent scans into one suggestion batch. */
export function runTick(input: TickInput): NewSuggestion[] {
  const now = input.now ?? new Date();
  return [
    ...athleteAgentScan(input.athletes, now),
    ...coachAgentScan(input.athletes),
    ...scoutAgentScan(input.selections),
  ];
}
