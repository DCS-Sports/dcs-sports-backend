/**
 * S1 CONTRACT TYPES (frozen, 19 Jun 2026 Manager reply)
 * CW10 owns: sports_athletes, sports_athlete_stats, sports_match_performances, sports_media
 * CW10 reads: sports_parent_links (CW9), ball-by-ball event shape (CW12)
 * Source of truth = DAY0_MANAGER_REPLY S1. Do NOT add fields not in the freeze.
 */

export type Visibility = 'private' | 'academy' | 'discoverable' | 'public';
export type StatSource = 'match' | 'manual' | 'vision';
export type MediaType = 'video' | 'image' | 'doc';

/** sports_athletes (CW10-owned) */
export interface Athlete {
  id: string;                  // uuid
  user_id: string;             // -> sports_users.id
  sport: string;               // 'cricket' (sport-agnostic config #1)
  role: string | null;         // batsman/bowler/all-rounder/wk
  batting_style: string | null;
  bowling_style: string | null;
  state: string | null;
  district: string | null;
  dob: string | null;          // date — drives minor (<18) RLS gate (CW9 enforces)
  verified_status: string | null;
  academy_id: string | null;
  visibility: Visibility;
  created_at: string;          // timestamptz
}

/** sports_athlete_stats (CW10-owned) — R1 = pure aggregation, no AI */
export interface AthleteStats {
  id: string;
  athlete_id: string;
  season: string;
  matches: number;
  runs: number;
  wickets: number;
  avg: number;
  strike_rate: number;
  batting_rating: number;      // aggregated, NOT estimate (no S4 envelope in R1)
  bowling_rating: number;
  fielding_rating: number;
  source: StatSource;
}

/** sports_match_performances (CW10-owned; written by CW12 score aggregation) */
export interface MatchPerformance {
  id: string;
  match_id: string;
  athlete_id: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  overs: number;
  wickets: number;
  runs_conceded: number;
  catches: number;
  source: StatSource;
}

/** sports_media (CW10-owned) */
export interface Media {
  id: string;
  athlete_id: string;
  type: MediaType;
  url: string;
  created_at: string;
}

/** sports_parent_links (CW9-owned; CW10 reads for Parent OS) */
export interface ParentLink {
  parent_user_id: string;
  athlete_id: string;
  relation: string;
  consent: boolean;
  consented_at: string | null;
}

/**
 * CW12 ball-by-ball event shape (S2 frozen) — the M-S1 contract CW10 reads.
 * CW12 aggregates these into sports_match_performances; CW10 reads the result.
 * Documented here so the passport timeline can render live events if surfaced.
 */
export interface BallByBallEvent {
  match_id: string;
  athlete_id: string;
  event: 'run' | 'wicket' | 'catch' | string;
  runs?: number;
  ball: number;
  over: number;
  ts: string;
}

/** Passport timeline entry (CW10 composes from matches + media + achievements) */
export interface TimelineEntry {
  id: string;
  athlete_id: string;
  kind: 'match' | 'media' | 'achievement' | 'verification';
  ref_id: string;
  label: string;
  ts: string;
}

/** Parent OS alert (CW10; alert *engine* is CW16 R2 — R1 = read-shape stub) */
export interface ParentAlert {
  id: string;
  athlete_id: string;
  type: 'absent_today' | 'perf_drop' | 'upcoming_match' | 'selection_result' | string;
  message: string;
  ts: string;
  read: boolean;
}

/** Parent OS child summary (composed by CW10 from athlete + performances) */
export interface ChildSummary {
  athlete_id: string;
  name_ref: string;
  sport: string;
  role: string | null;
  recent_matches: number;
  visibility: Visibility;
}

/* ---- MAXIMUM BUILD additions (full CW10 surface) ---- */

/** Passport create/update payload (CW10 owns athlete-row writes via service role). */
export interface AthleteUpsert {
  user_id?: string;
  sport?: string;
  role?: string | null;
  batting_style?: string | null;
  bowling_style?: string | null;
  state?: string | null;
  district?: string | null;
  dob?: string | null;
  academy_id?: string | null;
  visibility?: Visibility;
}

/** Attendance row (sports_attendance, written by CW11; Parent OS reads). */
export interface AttendanceRow {
  id: string;
  athlete_id: string;
  academy_id: string;
  date: string;
  present: boolean;
  note: string | null;
}

/** Assessment row (sports_assessments, written by CW11 Coach OS; Parent OS reads). */
export interface AssessmentRow {
  id: string;
  athlete_id: string;
  coach_id: string;
  scores_json: Record<string, number>;
  date: string;
}

/** Progress point — composed by CW10 from match performances over time. */
export interface ProgressPoint {
  ts: string;
  runs: number;
  balls: number;
  strike_rate: number;
  wickets: number;
}

/** Parent report — composed read: child summary + attendance rate + recent form. */
export interface ChildReport {
  athlete_id: string;
  name_ref: string;
  attendance_rate: number | null; // 0..1, null if no academy link / no data
  matches_played: number;
  recent_form: ProgressPoint[];
  coach_notes: CoachNote[];
}

/** Coach note — derived from assessments (sports_assessments). Read-only in Parent OS. */
export interface CoachNote {
  id: string;
  date: string;
  summary: string;
}

/* ---- v2.0: video highlights · aiScout drill · recruiting profile ---- */

/** A vision job CW10 submits; CW15's worker processes it. */
export interface VisionJob {
  id: string;
  athlete_id: string;
  kind: 'drill' | 'match_clip';
  video_url: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  version: string | null;
  created_at: string;
}

/** S4 estimate envelope (frozen) — every AI numeric output ships this. */
export interface Estimate {
  value: number;
  confidence: number;      // 0..1
  estimate: true;
  source: 'vision' | 'talent' | 'coach_ai' | 'scout_ai';
  model_version: string | null;
  generated_at: string;
  human_reviewed: boolean;
}

/** Talent estimate as rendered on the passport (composite + sub-skills, estimate-labeled). */
export interface TalentEstimate {
  athlete_id: string;
  composite: Estimate | null;          // null until a drill/match is processed (model DARK)
  skills: { name: string; estimate: Estimate }[];
  computed_at: string | null;
  model_dark: boolean;                 // true when no real model has run yet
}

/** An auto-highlight produced from a drill/match clip (CW15 output; CW10 renders). */
export interface Highlight {
  id: string;
  athlete_id: string;
  job_id: string;
  title: string;
  clip_url: string;
  thumb_url: string | null;
  created_at: string;
}

/** Public recruiting/exposure profile — scout-facing, RLS-safe, minors gated. */
export interface RecruitingProfile {
  athlete_id: string;
  name_ref: string;
  sport: string;
  role: string | null;
  state: string | null;
  district: string | null;
  verified: boolean;
  visibility: Visibility;
  headline_stats: { label: string; value: string | number }[];
  talent: TalentEstimate;
  highlights: Highlight[];
  share_url: string;
}

/* ---- v3.0: Career GPS · Digital Twin · Agent · Selection History ---- */

/** A step on the verified selection pathway (grassroots → pro). */
export interface PathwayLevel {
  key: string;            // 'club' | 'district' | 'state' | 'domestic' | 'national'
  label: string;
  reached: boolean;
  current: boolean;
}

/** Career GPS: where you are, the next milestone, the gap, and an estimate-labeled plan. */
export interface CareerGPS {
  athlete_id: string;
  levels: PathwayLevel[];
  current_level: string;
  next_milestone: { label: string; level: string } | null;
  gaps: { area: string; note: string }[];
  plan: { step: string; rationale: string }[];
  estimate: true;          // the whole pathway read is guidance, not a guarantee
  confidence: number;      // 0..1, conservative
  data_gated: boolean;     // true when too little real data to be meaningful
}

/** Digital Twin v0 — conservative workload/trend/injury-risk estimate, data-gated. */
export interface DigitalTwin {
  athlete_id: string;
  workload: { recent_matches: number; trend: 'up' | 'flat' | 'down' | 'insufficient' };
  injury_risk: { band: 'low' | 'moderate' | 'elevated' | 'insufficient'; estimate: true; confidence: number };
  notes: string[];
  data_gated: boolean;     // true => we show "not enough data yet", never a fake risk number
}

/** A human-gated agent ping (from sports_agent_suggestions). Suggests; never acts. */
export interface AgentPing {
  id: string;
  athlete_id: string;
  agent: string;           // 'athlete_agent'
  title: string;
  body: string;
  high_stakes: boolean;
  status: 'pending' | 'acknowledged' | 'dismissed' | 'actioned';
  created_at: string;
}

/** A signed verified-selection record (from CW13 / sports_verifications). */
export interface SelectionRecord {
  id: string;
  athlete_id: string;
  title: string;           // 'State U19 squad 2025'
  level: string;
  date: string;
  verified_by: string | null;
  sig: string | null;      // ed25519 signature (CW13). Presence => provable.
  verify_url: string;      // public verify link
}
