// src/calibration.mjs
// DCS Sports · CW4 — Calibration & health-check engine.
//
// The engine that REFUSES FALSE CONFIDENCE. Per the dispatch: a per-match checklist
// (camera pose, lens distortion, pitch/crease/stump coords, fps, clock offset, occlusion,
// lighting, movement, A/V sync) → PASS / DEGRADED / FAIL per camera → DRS-eligibility
// FULL / LIMITED / OFF.
//
// 🔴 THE HARD RULE (dispatch, verbatim): calibration != PASS ⇒ trajectory-based assist DISABLED,
// and the UI must show WHY. That rule lives in `trajectoryAssistAllowed()` below and is the one
// thing in this lane that must never be softened: a trajectory drawn from an uncalibrated camera
// is a confident-looking lie, and a human being makes a decision on it.
//
// Naming: this is DCS Umpire Assist. Never "AI umpire" — the human decides, always.
// Nothing here is autonomous: the output is an eligibility report for an official to read.

/** The 9 checks the dispatch enumerates. Order is the report order. */
export const CHECKS = Object.freeze([
  'camera_pose',        // extrinsics known & stable
  'lens_distortion',    // intrinsics/undistortion solved
  'pitch_crease_stumps',// ground-truth coords surveyed to the model
  'fps',                // capture rate adequate & steady
  'clock_offset',       // camera clock vs match clock
  'occlusion',          // sightline to the action
  'lighting',           // exposure adequate/stable
  'movement',           // rig stability (a moved camera invalidates pose)
  'av_sync',            // audio↔video alignment (edge detection depends on it)
]);

/** Per-check verdicts. A check is PASS, DEGRADED or FAIL — or UNKNOWN when not measured. */
export const VERDICT = Object.freeze({ PASS: 'PASS', DEGRADED: 'DEGRADED', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN' });

/** DRS eligibility tiers. */
export const ELIGIBILITY = Object.freeze({ FULL: 'FULL', LIMITED: 'LIMITED', OFF: 'OFF' });

/**
 * Checks whose failure makes trajectory geometry meaningless. If any of these is not PASS,
 * trajectory-based assist is DISABLED — no exceptions, no "best effort" trajectory.
 * Rationale (why THESE): a trajectory is a 3-D reconstruction. It requires known camera pose,
 * solved lens distortion, surveyed ground truth, adequate/steady frame rate, a stable rig, and
 * an unobstructed sightline. Any one of those missing and the line on screen is decoration.
 */
export const TRAJECTORY_CRITICAL = Object.freeze([
  'camera_pose', 'lens_distortion', 'pitch_crease_stumps', 'fps', 'movement', 'occlusion',
]);

/**
 * assessCamera — roll per-check verdicts into one camera verdict. Honest by construction:
 * an UNMEASURED check is never treated as a pass.
 *
 * @param {{cameraId:string, checks:Record<string,{verdict:string, detail?:string, measured?:boolean}>}} input
 */
export function assessCamera(input) {
  const cameraId = input?.cameraId ?? 'unknown';
  const given = input?.checks ?? {};
  const results = CHECKS.map((name) => {
    const c = given[name];
    // A check that was not run is UNKNOWN — not a pass. Absence of evidence is not calibration.
    if (!c || typeof c.verdict !== 'string' || !(c.verdict in VERDICT)) {
      return { check: name, verdict: VERDICT.UNKNOWN, detail: 'not measured', measured: false };
    }
    return { check: name, verdict: c.verdict, detail: c.detail ?? '', measured: c.measured !== false };
  });

  const has = (v) => results.some((r) => r.verdict === v);
  // FAIL dominates; then UNKNOWN (unmeasured is not "fine"); then DEGRADED; else PASS.
  const verdict = has(VERDICT.FAIL) ? VERDICT.FAIL
    : has(VERDICT.UNKNOWN) ? VERDICT.DEGRADED   // unmeasured ⇒ at best DEGRADED, never PASS
    : has(VERDICT.DEGRADED) ? VERDICT.DEGRADED
    : VERDICT.PASS;

  const failing = results.filter((r) => r.verdict !== VERDICT.PASS);
  return { cameraId, verdict, checks: results, failing: failing.map((f) => ({ check: f.check, verdict: f.verdict, detail: f.detail })) };
}

/**
 * trajectoryAssistAllowed — 🔴 THE HARD RULE.
 * Trajectory-based assist is allowed ONLY when the camera verdict is PASS and every
 * trajectory-critical check is PASS. Returns the reason when disabled, so the UI can show WHY.
 */
export function trajectoryAssistAllowed(cameraAssessment) {
  if (!cameraAssessment || cameraAssessment.verdict !== VERDICT.PASS) {
    const why = (cameraAssessment?.failing ?? []).map((f) => `${f.check}: ${f.verdict}${f.detail ? ` (${f.detail})` : ''}`);
    return {
      allowed: false,
      reason: `calibration is ${cameraAssessment?.verdict ?? 'UNKNOWN'} — trajectory assist disabled`,
      failing: why.length ? why : ['calibration not PASS'],
    };
  }
  const criticalFails = cameraAssessment.checks
    .filter((c) => TRAJECTORY_CRITICAL.includes(c.check) && c.verdict !== VERDICT.PASS);
  if (criticalFails.length) {
    return {
      allowed: false,
      reason: 'a trajectory-critical check is not PASS — trajectory assist disabled',
      failing: criticalFails.map((c) => `${c.check}: ${c.verdict}`),
    };
  }
  return { allowed: true, reason: 'calibration PASS on all trajectory-critical checks', failing: [] };
}

/**
 * matchCalibrationReport — the per-match API payload an official reads.
 * DRS eligibility:
 *   FULL    — ≥2 cameras PASS and trajectory allowed on them (multi-view geometry available)
 *   LIMITED — ≥1 camera usable (PASS/DEGRADED) but trajectory not available on ≥2 → non-trajectory
 *             assists only (e.g. audio/frame evidence for a human to read)
 *   OFF     — no usable camera
 */
export function matchCalibrationReport({ matchId, cameras = [], calibrationVersion = null, at = null } = {}) {
  const assessments = cameras.map(assessCamera);
  const trajectory = assessments.map((a) => ({ cameraId: a.cameraId, ...trajectoryAssistAllowed(a) }));

  const trajectoryCameras = trajectory.filter((t) => t.allowed).length;
  const usableCameras = assessments.filter((a) => a.verdict !== VERDICT.FAIL).length;

  const eligibility = trajectoryCameras >= 2 ? ELIGIBILITY.FULL
    : usableCameras >= 1 ? ELIGIBILITY.LIMITED
    : ELIGIBILITY.OFF;

  // Why, in plain language, for the console to display verbatim.
  const rationale = eligibility === ELIGIBILITY.FULL
    ? `${trajectoryCameras} cameras calibrated PASS — trajectory-based assist available`
    : eligibility === ELIGIBILITY.LIMITED
      ? `trajectory assist unavailable (${trajectoryCameras} of ${cameras.length} cameras trajectory-eligible) — evidence review only, no trajectory`
      : 'no usable camera — DCS Umpire Assist off for this match';

  return {
    matchId: matchId ?? null,
    calibrationVersion,                 // recorded so evidence bundles can cite it (CW6)
    computedAt: at ?? new Date().toISOString(),
    cameras: assessments,
    trajectory,
    trajectoryEligibleCameras: trajectoryCameras,
    usableCameras,
    eligibility,
    rationale,
    // The decision is ALWAYS human. This engine gates a tool; it never rules.
    decisionAuthority: 'HUMAN',
    product: 'DCS Umpire Assist',
  };
}

/**
 * evidenceSummary — the console's evidence block, built ONLY from what was measured.
 * Any absent input renders an em-dash: we do not invent a sync figure or a confidence.
 */
export function evidenceSummary({ report, sourcesAvailable = null, sourcesTotal = null, trackingConfidence = null, audioSyncMs = null, recommendation = null } = {}) {
  const dash = '\u2014';
  const traj = report?.trajectory?.some((t) => t.allowed) ?? false;
  return {
    evidence: (sourcesAvailable != null && sourcesTotal != null) ? `${sourcesAvailable}/${sourcesTotal}` : dash,
    tracking: trackingConfidence != null ? `${Math.round(trackingConfidence * 100)}%` : dash,
    audioSync: audioSyncMs != null ? `±${audioSyncMs}ms` : dash,
    calibration: report?.eligibility === ELIGIBILITY.FULL ? 'valid'
      : report?.eligibility === ELIGIBILITY.LIMITED ? 'limited'
      : report ? 'invalid' : dash,
    trajectoryAvailable: traj,
    // recommendation is an ESTIMATE and is labelled as one; never a verdict.
    recommendation: recommendation ? { text: recommendation, estimate: true, label: 'estimate · not a decision' } : dash,
    finalDecision: 'HUMAN',
  };
}
