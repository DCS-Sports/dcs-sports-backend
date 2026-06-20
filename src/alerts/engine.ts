// src/alerts/engine.ts
// Alerts engine v1 (R2). Pure classification — given facts, produce alerts.
// Transport (Resend email / push) is wired separately; this stays testable.
export type AlertType =
  | 'absent_today'
  | 'perf_drop'
  | 'upcoming_match'
  | 'selection_result';

export interface Alert {
  type: AlertType;
  athlete_id: string;
  recipient_role: 'parent' | 'athlete' | 'academy_admin' | 'coach';
  message: string;
  severity: 'info' | 'warn';
  created_at: string;
}

export interface AlertFacts {
  athlete_id: string;
  present_today?: boolean | null;
  recent_avg?: number | null;     // last-N matches batting/bowling rating
  baseline_avg?: number | null;   // season baseline
  next_match_at?: string | null;  // ISO
  now?: string;                   // ISO, injectable for tests
  selection?: { league: string; selected: boolean } | null;
}

const PERF_DROP_THRESHOLD = 0.15; // 15% relative drop triggers a warn

export function evaluateAlerts(f: AlertFacts): Alert[] {
  const now = f.now ? new Date(f.now) : new Date();
  const out: Alert[] = [];
  const stamp = now.toISOString();

  if (f.present_today === false) {
    out.push({
      type: 'absent_today',
      athlete_id: f.athlete_id,
      recipient_role: 'parent',
      message: 'Marked absent at the academy today.',
      severity: 'info',
      created_at: stamp,
    });
  }

  if (
    typeof f.recent_avg === 'number' &&
    typeof f.baseline_avg === 'number' &&
    f.baseline_avg > 0 &&
    (f.baseline_avg - f.recent_avg) / f.baseline_avg >= PERF_DROP_THRESHOLD
  ) {
    out.push({
      type: 'perf_drop',
      athlete_id: f.athlete_id,
      recipient_role: 'coach',
      message: 'Recent form below season baseline — review training load.',
      severity: 'warn',
      created_at: stamp,
    });
  }

  if (f.next_match_at) {
    const hrs = (new Date(f.next_match_at).getTime() - now.getTime()) / 3_600_000;
    if (hrs > 0 && hrs <= 24) {
      out.push({
        type: 'upcoming_match',
        athlete_id: f.athlete_id,
        recipient_role: 'athlete',
        message: 'Match within 24 hours.',
        severity: 'info',
        created_at: stamp,
      });
    }
  }

  if (f.selection) {
    out.push({
      type: 'selection_result',
      athlete_id: f.athlete_id,
      recipient_role: 'parent',
      message: f.selection.selected
        ? `Selected for ${f.selection.league}.`
        : `Not selected for ${f.selection.league} this round.`,
      severity: 'info',
      created_at: stamp,
    });
  }

  return out;
}
