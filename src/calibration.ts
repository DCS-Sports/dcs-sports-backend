// src/calibration.ts — DCS Sports · CW4 Calibration & health-check engine (ported to TS).
// The engine that REFUSES FALSE CONFIDENCE. calibration != PASS ⇒ trajectory assist DISABLED.
// Naming: DCS Umpire Assist — the human decides, always. Nothing here is autonomous.

export const CHECKS = Object.freeze([
  'camera_pose', 'lens_distortion', 'pitch_crease_stumps', 'fps', 'clock_offset',
  'occlusion', 'lighting', 'movement', 'av_sync',
]);

export const VERDICT = Object.freeze({ PASS: 'PASS', DEGRADED: 'DEGRADED', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN' } as Record<string, string>);
export const ELIGIBILITY = Object.freeze({ FULL: 'FULL', LIMITED: 'LIMITED', OFF: 'OFF' } as Record<string, string>);

// Checks whose failure makes trajectory geometry meaningless.
export const TRAJECTORY_CRITICAL = Object.freeze([
  'camera_pose', 'lens_distortion', 'pitch_crease_stumps', 'fps', 'movement', 'occlusion',
]);

export function assessCamera(input: any) {
  const cameraId = input?.cameraId ?? 'unknown';
  const given = input?.checks ?? {};
  const results = CHECKS.map((name) => {
    const c = given[name];
    if (!c || typeof c.verdict !== 'string' || !(c.verdict in VERDICT)) {
      return { check: name, verdict: VERDICT.UNKNOWN, detail: 'not measured', measured: false };
    }
    return { check: name, verdict: c.verdict, detail: c.detail ?? '', measured: c.measured !== false };
  });
  const has = (v: string) => results.some((r) => r.verdict === v);
  const verdict = has(VERDICT.FAIL) ? VERDICT.FAIL
    : has(VERDICT.UNKNOWN) ? VERDICT.DEGRADED
    : has(VERDICT.DEGRADED) ? VERDICT.DEGRADED
    : VERDICT.PASS;
  const failing = results.filter((r) => r.verdict !== VERDICT.PASS);
  return { cameraId, verdict, checks: results, failing: failing.map((f) => ({ check: f.check, verdict: f.verdict, detail: f.detail })) };
}

export function trajectoryAssistAllowed(a: any) {
  if (!a || a.verdict !== VERDICT.PASS) {
    const why = (a?.failing ?? []).map((f: any) => `${f.check}: ${f.verdict}${f.detail ? ` (${f.detail})` : ''}`);
    return { allowed: false, reason: `calibration is ${a?.verdict ?? 'UNKNOWN'} — trajectory assist disabled`, failing: why.length ? why : ['calibration not PASS'] };
  }
  const criticalFails = a.checks.filter((c: any) => TRAJECTORY_CRITICAL.includes(c.check) && c.verdict !== VERDICT.PASS);
  if (criticalFails.length) {
    return { allowed: false, reason: 'a trajectory-critical check is not PASS — trajectory assist disabled', failing: criticalFails.map((c: any) => `${c.check}: ${c.verdict}`) };
  }
  return { allowed: true, reason: 'calibration PASS on all trajectory-critical checks', failing: [] };
}

export function matchCalibrationReport({ matchId, cameras = [], calibrationVersion = null, at = null }: any = {}) {
  const assessments = cameras.map(assessCamera);
  const trajectory = assessments.map((a: any) => ({ cameraId: a.cameraId, ...trajectoryAssistAllowed(a) }));
  const trajectoryCameras = trajectory.filter((t: any) => t.allowed).length;
  const usableCameras = assessments.filter((a: any) => a.verdict !== VERDICT.FAIL).length;
  const eligibility = trajectoryCameras >= 2 ? ELIGIBILITY.FULL : usableCameras >= 1 ? ELIGIBILITY.LIMITED : ELIGIBILITY.OFF;
  const rationale = eligibility === ELIGIBILITY.FULL
    ? `${trajectoryCameras} cameras calibrated PASS — trajectory-based assist available`
    : eligibility === ELIGIBILITY.LIMITED
      ? `trajectory assist unavailable (${trajectoryCameras} of ${cameras.length} cameras trajectory-eligible) — evidence review only, no trajectory`
      : 'no usable camera — DCS Umpire Assist off for this match';
  return {
    matchId: matchId ?? null, calibrationVersion, computedAt: at ?? new Date().toISOString(),
    cameras: assessments, trajectory, trajectoryEligibleCameras: trajectoryCameras, usableCameras,
    eligibility, rationale, decisionAuthority: 'HUMAN', product: 'DCS Umpire Assist',
  };
}
