/**
 * VISION V3/V4 OUTPUT CONTRACTS — the shapes the trained CV model emits.
 *
 * Honest-scope: these are the frozen shapes only. No values are produced until
 * DCS_VISION_MODEL_URL is set; until then the pipeline fails closed. When the
 * model lands, the worker fills these shapes and EVERY numeric field is wrapped
 * in the S4 estimate envelope (source:"vision", model_version:"<the model>").
 *
 * Defining the contract now means downstream (Passport, Match Center, the M-S
 * harness) can integrate against a stable interface today and light up later
 * with zero shape changes.
 */
import type { Estimate } from "../lib/estimate";

/** V3 — quantitative ball/event analysis. */
export interface VisionV3Delivery {
  /** Per-delivery ball speed (km/h), enveloped. */
  ball_speed: Estimate;
  /** Probability the chance was a catch (0..1 in value), enveloped. */
  catch_probability: Estimate;
  /** Win probability swing attributable to this delivery, enveloped. */
  win_probability: Estimate;
  /** Pitch map coordinates (normalized 0..1), with detection confidence. */
  pitch_xy: { x: number; y: number; confidence: number };
  ts_offset_s: number;
}

export interface VisionV3Output {
  type: "v3_analysis";
  deliveries: VisionV3Delivery[];
  /** Innings-level rollups, each enveloped. */
  summary: { avg_ball_speed: Estimate; chances_created: Estimate };
}

/** V4 — mini-DRS / boundary / umpire-assist (leagues only). */
export interface VisionV4Decision {
  /** Decision class, with model confidence. */
  decision: "out" | "not_out" | "boundary_four" | "boundary_six" | "no_decision";
  confidence: number;
  /** Ball-tracking projection points (normalized), if available. */
  track?: Array<{ x: number; y: number }>;
  /** Always human-reviewed before it takes effect (high-stakes). */
  requires_human_review: true;
  ts_offset_s: number;
}

export interface VisionV4Output {
  type: "v4_decision";
  decisions: VisionV4Decision[];
}

/** The output `type` strings persisted to sports_vision_outputs for V3/V4. */
export const V3_OUTPUT_TYPE = "v3_analysis" as const;
export const V4_OUTPUT_TYPE = "v4_decision" as const;
