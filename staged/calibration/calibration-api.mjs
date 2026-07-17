// src/calibration-api.mjs — CW4 · the calibration/health API surface (framework-agnostic handlers).
//
// The gateway wasn't provided this round, so these are pure handlers with no framework import —
// mount them in the real gateway in one line each (see HANDOFF). No route names invented beyond the
// dispatch's own vocabulary; confirm with the gateway owner before merge.
//
// READ-ONLY. No money, no autonomy, no flag. DARK by default.

import { matchCalibrationReport, assessCamera, trajectoryAssistAllowed, CHECKS } from './calibration.mjs';

/** GET /matches/:id/calibration → the per-match report an official reads. */
export async function getMatchCalibration({ matchId, loadCameras }) {
  if (typeof loadCameras !== 'function') throw new Error('loadCameras(matchId) must be supplied by the gateway');
  const cameras = await loadCameras(matchId);           // real rows; never fabricated here
  if (!Array.isArray(cameras) || cameras.length === 0) {
    return { status: 200, body: matchCalibrationReport({ matchId, cameras: [] }) };  // → OFF, honest
  }
  return { status: 200, body: matchCalibrationReport({ matchId, cameras }) };
}

/** GET /matches/:id/calibration/:cameraId → one camera + whether trajectory assist is allowed, and why. */
export async function getCameraCalibration({ matchId, cameraId, loadCameras }) {
  const cameras = await loadCameras(matchId);
  const found = (cameras || []).find((c) => c.cameraId === cameraId);
  if (!found) return { status: 404, body: { error: 'camera not found for match' } };
  const assessment = assessCamera(found);
  return { status: 200, body: { ...assessment, trajectory: trajectoryAssistAllowed(assessment) } };
}

/** The checklist itself — so the console/UI renders the same 9 items the engine scores. */
export function getChecklistSpec() {
  return { status: 200, body: { checks: CHECKS, verdicts: ['PASS', 'DEGRADED', 'FAIL', 'UNKNOWN'], eligibility: ['FULL', 'LIMITED', 'OFF'], product: 'DCS Umpire Assist', decisionAuthority: 'HUMAN' } };
}
