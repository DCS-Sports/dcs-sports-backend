// CW14 · R6 CALIBRATION HARNESS (build-gated only).
// Recompute is real + deterministic. The VALIDATION verdict is adoption-gated:
// without real match data (League OS) the composite stays estimate-labeled and
// `validated:false`. Confidence scales honestly with sample_size — we never
// claim certainty we haven't earned.

import { estimate } from './honest_scope';
import type { CalibrationInput, CalibrationResult } from './contracts';

// Weighted composite. Weights are explicit + auditable (not a black box).
const WEIGHTS = { skill: 0.30, potential: 0.20, consistency: 0.20, pressure: 0.12, fitness: 0.10, coach: 0.08 };

export function computeComposite(sub: CalibrationInput['sub_scores']): number {
  const raw =
    sub.skill * WEIGHTS.skill +
    sub.potential * WEIGHTS.potential +
    sub.consistency * WEIGHTS.consistency +
    sub.pressure * WEIGHTS.pressure +
    sub.fitness * WEIGHTS.fitness +
    sub.coach * WEIGHTS.coach;
  return Math.round(raw * 10) / 10;
}

// Confidence is a function of how much REAL data backs the scores.
// 0 matches => 0.10 floor (pure prior); grows, caps at 0.85 until validated.
export function confidenceFromSample(n: number): number {
  if (n <= 0) return 0.10;
  const c = 0.10 + 0.75 * (1 - Math.exp(-n / 12)); // saturating curve
  return Math.min(0.85, Math.round(c * 100) / 100);
}

export function dataReadiness(n: number): CalibrationResult['data_readiness'] {
  if (n < 3) return 'insufficient';
  if (n < 15) return 'emerging';
  return 'sufficient';
}

export function calibrate(input: CalibrationInput): CalibrationResult {
  const composite = computeComposite(input.sub_scores);
  const confidence = confidenceFromSample(input.sample_size);
  return {
    athlete_id: input.athlete_id,
    composite: estimate<number>(composite, confidence, 'talent', 'calibration-v1'),
    validated: false,            // FROZEN: real validation needs adoption ground-truth
    data_readiness: dataReadiness(input.sample_size),
  };
}
