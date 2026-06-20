/**
 * CW15 ACCEPTANCE FIXTURE — for CW16's M-S3 / M-S4 gates.
 *
 * Deterministic seed + the EXACT outputs CW15 produces from it, so CW16's
 * harness can assert green without guessing. Honest-scope: expected values are
 * computed by the real services (not hand-written), and the AI fields are the
 * heuristic envelope (model_version:null, estimate:true) — the gate verifies
 * the platform stages an HONEST estimate, not a fabricated number.
 */
import type { MatchPerformance } from "../db/port";

export const FIXTURE_ATHLETE = "ath_fixture_001";

/** 6 innings, middle-order batter. Stable input for the gate. */
export const FIXTURE_PERFORMANCES: MatchPerformance[] = [
  { id: "mp_1", match_id: "m_1", athlete_id: FIXTURE_ATHLETE, runs: 45, balls: 32, fours: 4, sixes: 2, overs: 2, wickets: 0, runs_conceded: 14, catches: 1, source: "match" },
  { id: "mp_2", match_id: "m_2", athlete_id: FIXTURE_ATHLETE, runs: 38, balls: 30, fours: 3, sixes: 1, overs: 2, wickets: 0, runs_conceded: 14, catches: 0, source: "match" },
  { id: "mp_3", match_id: "m_3", athlete_id: FIXTURE_ATHLETE, runs: 52, balls: 40, fours: 5, sixes: 2, overs: 2, wickets: 1, runs_conceded: 14, catches: 1, source: "match" },
  { id: "mp_4", match_id: "m_4", athlete_id: FIXTURE_ATHLETE, runs: 28, balls: 22, fours: 2, sixes: 1, overs: 2, wickets: 0, runs_conceded: 14, catches: 0, source: "match" },
  { id: "mp_5", match_id: "m_5", athlete_id: FIXTURE_ATHLETE, runs: 61, balls: 44, fours: 6, sixes: 3, overs: 2, wickets: 0, runs_conceded: 14, catches: 2, source: "match" },
  { id: "mp_6", match_id: "m_6", athlete_id: FIXTURE_ATHLETE, runs: 33, balls: 26, fours: 3, sixes: 1, overs: 2, wickets: 2, runs_conceded: 14, catches: 0, source: "match" },
];

/** Performance Lab inputs feeding the Talent composite. */
export const FIXTURE_FITNESS = { fitnessScore: 72, coachScore: 65 };

/** Expected Talent output (computed by the real service from the seed above). */
export const EXPECTED_TALENT = {
  athlete_id: FIXTURE_ATHLETE,
  sub_scores: { skill: 80.3, potential: 62.6, consistency: 74.3, pressure: 71, fitness: 72, coach: 65 },
  composite_value: 72.69,
  composite_confidence: 0.31,
  composite_source: "talent" as const,
  composite_model_version: null, // heuristic — the honest signal the gate checks
  sample_size: 6,
};

/** Expected Vision V1 output shape (heuristic; the gate checks structure + honesty). */
export const EXPECTED_VISION_V1 = {
  job_status: "done" as const,
  output_types: ["highlight", "event_tag"],
  method: "heuristic_placeholder",
  max_confidence: 0.25, // heuristic outputs cap low — gate asserts <= this
};

/** Expected DARK-gate behavior (M-S4 must show fail-closed, not a fake number). */
export const EXPECTED_DARK = {
  vision_v3_status: "model_unavailable" as const,
  coach_ai_http_status: 503,
  coach_ai_error: "MODEL_UNAVAILABLE",
};
