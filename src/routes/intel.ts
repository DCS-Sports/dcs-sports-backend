// src/routes/intel.ts — DCS Sports match-intelligence routes.
// Takes the staged CW4/CW5/CW6 work LIVE as read-only official/coach endpoints:
//   GET /matches/:id/twin        — CW5 Match Twin Lite (2D field map from real ball data)
//   GET /matches/:id/copilot     — CW5 Tactical Copilot v0 (zones/pressure/line-length/matchup)
//   GET /matches/:id/calibration — CW4 calibration eligibility (OFF until camera data exists)
//   GET /matches/:id/evidence-passport — CW6 Match Evidence Passport (gated on signing key)
// Everything estimate-labelled; no autonomous scoring; the human decides, always.
import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { svc, ok, fail, h } from './_helpers';
import { buildMatchTwin, batterScoringZones, dotBallPressure, bowlerLineLength, matchup, expectedRunsNextOver } from '../twin-copilot';
import { matchCalibrationReport } from '../calibration';

export const intelRouter = Router();

// map the stored numeric shot.dir (0..7, from the scoring console) → CW5's ShotDir enum
const DIR: string[] = ['fine_leg', 'square_leg', 'mid_wicket', 'mid_on', 'mid_off', 'covers', 'point', 'third_man'];

async function loadState(matchId: string) {
  const { data } = await svc().from('sports_live_scores').select('event_json,ts').eq('match_id', matchId).order('ts', { ascending: true }).limit(900);
  const evs = (data ?? []).map((r: any) => r.event_json || {}).filter((e: any) => e.kind === 'rich');
  // use the live innings (2 if any 2nd-innings balls exist, else 1)
  const has2 = evs.some((e: any) => Number(e.innings) === 2);
  const balls = evs.filter((e: any) => (Number(e.innings) || 1) === (has2 ? 2 : 1)).map((e: any) => ({
    over: e.over ?? 0, ball: e.ball ?? 0,
    batter: (e.striker && e.striker.name) || '', bowler: (e.bowler && e.bowler.name) || '',
    runs: Number(e.runs || 0), extras: e.extra ? Number(e.extra.runs || 0) : 0, wicket: !!e.wicket,
    shot: e.shot && e.shot.dir != null ? { dir: DIR[Number(e.shot.dir)] as any } : undefined,
    pitch: e.pitch || null, tsIso: e.ts,
  }));
  const last = evs[evs.length - 1] || {};
  return {
    matchId,
    striker: (last.striker && last.striker.name) || '', nonStriker: (last.non_striker && last.non_striker.name) || '',
    bowler: (last.bowler && last.bowler.name) || '', balls,
  };
}

intelRouter.get('/matches/:id/twin', requireAuth, h(async (req: AuthedRequest, res) => {
  const state = await loadState(req.params.id);
  return ok(res, buildMatchTwin(state as any, []));
}));

intelRouter.get('/matches/:id/copilot', requireAuth, h(async (req: AuthedRequest, res) => {
  const state = await loadState(req.params.id);
  const b = state.balls as any[];
  const striker = state.striker, bowler = state.bowler;
  return ok(res, {
    matchId: req.params.id,
    zones: striker ? batterScoringZones(b as any, striker) : null,
    pressure: dotBallPressure(b as any),
    lineLength: bowler ? bowlerLineLength(b as any, bowler) : null,
    matchup: (striker && bowler) ? matchup(b as any, striker, bowler) : null,
    expectedNextOver: expectedRunsNextOver(b as any),
    note: 'estimate-labelled · recommends only · a human decides',
  });
}));

intelRouter.get('/matches/:id/calibration', requireAuth, h(async (req: AuthedRequest, res) => {
  // No camera-calibration input is captured yet, so eligibility is OFF by construction —
  // the engine refuses false confidence. When a venue supplies calibration data (Wave 2),
  // it flows in here as `cameras` and the report lights up.
  return ok(res, matchCalibrationReport({ matchId: req.params.id, cameras: [] }));
}));

intelRouter.get('/matches/:id/evidence-passport', requireAuth, h(async (req: AuthedRequest, res) => {
  // The Match Evidence Passport signs a chained bundle. Signing requires a dedicated evidence
  // key. Until it's provisioned (after the ed25519 rotation), we report honestly rather than
  // sign with an unconfigured/compromised key.
  const keyReady = Boolean(process.env.SPORTS_EVIDENCE_SK || process.env.RECEIPT_SK);
  if (!keyReady) {
    return ok(res, {
      matchId: req.params.id, configured: false,
      reason: 'evidence signing key not set — provision SPORTS_EVIDENCE_SK (after the ed25519 rotation) to enable signed Match Evidence Passports',
      product: 'Match Evidence Passport', note: 'tamper-evident: proves the record was not silently rewritten; does not prove a decision was correct',
    });
  }
  // key present → assemble incidents from resolved camera events and return an unsigned draft
  // (full signed bundle assembly ships once the key is confirmed in place).
  const { data } = await svc().from('sports_tracked_events').select('id,type,over,ball,confidence,estimate,data_json,created_at').eq('match_id', req.params.id).not('data_json->>resolved', 'is', null);
  const incidents = (data ?? []).map((x: any) => ({
    delivery_id: `${req.params.id}:${x.over}.${x.ball}`, type: x.type, confidence: x.confidence,
    decision: x.data_json?.resolved || null, reviewer: x.data_json?.resolved_by || null, resolved_at: x.data_json?.resolved_at || null, created_at: x.created_at,
  }));
  return ok(res, { matchId: req.params.id, configured: true, incidents, count: incidents.length, product: 'Match Evidence Passport', signed: false, note: 'draft — signed bundle enabled once the evidence key is confirmed' });
}));
