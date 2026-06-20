/**
 * aiScout PHONE-DRILL ASSESSMENT — contracts (v2.0 headline capability).
 *
 * An athlete records a STANDARD drill on their phone → the worker returns an
 * athleticism/skill estimate (speed, agility, technique) with confidence.
 * "Get discovered from anywhere."
 *
 * Honest-scope: the real measurement needs a trained pose/CV model. Until DK
 * provisions DCS_VISION_MODEL_URL + a drill runner, the assessment runs in
 * HEURISTIC mode (deterministic placeholders, model_version:null, low
 * confidence) OR fails closed for drills that strictly require the model. No
 * fabricated "athleticism score" is ever presented as measured.
 */
import type { Estimate } from "../lib/estimate";

/** Supported standard drills (extensible; cricket-first). */
export type DrillType =
  | "sprint_20m"        // speed
  | "agility_5_10_5"    // agility (pro-agility shuttle)
  | "vertical_jump"     // power
  | "batting_technique" // skill (cricket)
  | "bowling_run_up";   // skill (cricket)

export const DRILL_TYPES: DrillType[] = [
  "sprint_20m",
  "agility_5_10_5",
  "vertical_jump",
  "batting_technique",
  "bowling_run_up",
];

/** Which athletic attribute each drill primarily measures. */
export const DRILL_ATTRIBUTE: Record<DrillType, "speed" | "agility" | "power" | "technique"> = {
  sprint_20m: "speed",
  agility_5_10_5: "agility",
  vertical_jump: "power",
  batting_technique: "technique",
  bowling_run_up: "technique",
};

/**
 * Drills whose numeric result REQUIRES a trained model to be credible. These
 * fail closed when the model is DARK (no heuristic stand-in for a real metric
 * like measured sprint time from pose tracking).
 *
 * Technique drills can ship a heuristic "form checklist" placeholder now; the
 * timed/measured drills cannot fabricate a number.
 */
export const DRILL_MODEL_REQUIRED: Record<DrillType, boolean> = {
  sprint_20m: true,
  agility_5_10_5: true,
  vertical_jump: true,
  batting_technique: false, // heuristic form-cue checklist allowed
  bowling_run_up: false,
};

export interface DrillAssessmentResult {
  athlete_id: string;
  drill: DrillType;
  attribute: "speed" | "agility" | "power" | "technique";
  /** The headline athleticism/skill estimate (0..100), enveloped. */
  score: Estimate;
  /** Optional raw measure when a model produced one (e.g. sprint seconds), enveloped. */
  raw_measure?: Estimate;
  /** Heuristic form cues for technique drills (no fabricated numbers). */
  form_cues?: string[];
  /** True if this assessment fed the Talent Index. */
  contributed_to_talent: boolean;
}

/** The output `type` persisted to sports_vision_outputs for a drill assessment. */
export const DRILL_OUTPUT_TYPE = "drill_assessment" as const;

/** Auto-highlight reel output (markerless tracking → stitched clips). */
export interface AutoHighlightResult {
  type: "auto_highlight";
  clips: Array<{ start_s: number; end_s: number; label: string; confidence: number }>;
  method: string; // "heuristic_placeholder" until the tracking model lands
}
export const AUTO_HIGHLIGHT_OUTPUT_TYPE = "auto_highlight" as const;
