/**
 * DCS Sports · CW5 — Match Twin Lite (2D) + Tactical Match Copilot v0
 * src/twin-copilot.ts   ·   16 Jul 2026
 *
 * "The fusion layer's visible face — no cameras needed for v0."
 *
 * Everything here is computed from BALL-BY-BALL SCORING DATA that already exists
 * (`shot.dir` is captured today). No camera, no vision model, no tracking.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO RULES THIS MODULE ENFORCES IN CODE
 *
 * 1. EVERY derived output is ESTIMATE-LABELLED. Not a footnote — a field on the
 *    value itself (`estimate: true`, `basis`, `sampleSize`). A caller cannot render
 *    one of these numbers without also having the label in hand.
 *
 * 2. NO DATA → AN EM-DASH. Never a plausible number. Where the roadmap says a
 *    surface is "UI ready, fills when pitch data lands" (bowler line/length), this
 *    returns `null` + `reason: 'no_pitch_data'` and the UI renders "—". Inventing a
 *    line/length map from deliveries that carry no pitch coordinates would be a
 *    fabricated number with a demo attached.
 *
 * Money/autonomy: DARK. `pilotFlag` gates the per-match pricing hook; nothing charges.
 * No autonomous scoring: the Copilot RECOMMENDS; a human decides (CW3/CW4 own confirm).
 */

/* ─────────────────────────── Data contract (existing scoring shape) ───────── */

/** Shot direction as already captured in match state. Clock-face wagon zones. */
export type ShotDir =
  | 'fine_leg' | 'square_leg' | 'mid_wicket' | 'mid_on'
  | 'mid_off' | 'covers' | 'point' | 'third_man';

export interface Ball {
  over: number;              // 0-based over index
  ball: number;              // 1..6 (+ extras)
  batter: string;
  bowler: string;
  runs: number;              // runs off the bat
  extras?: number;
  wicket?: boolean;
  shot?: { dir?: ShotDir };  // EXISTING captured field
  /** Pitch coordinates — NOT captured today. When null, line/length stays an em-dash. */
  pitch?: { x: number; y: number } | null;
  tsIso?: string;
}

export interface MatchState {
  matchId: string;
  striker: string;
  nonStriker: string;
  bowler: string;
  balls: Ball[];
}

/* ─────────────────────────── Estimate labelling (rule 1) ──────────────────── */

export interface Estimated<T> {
  value: T | null;
  /** Always true for derived cricket intelligence. The UI MUST render the label. */
  estimate: true;
  /** What the number was computed from — traceable, not a vibe. */
  basis: string;
  /** How many deliveries backed it. Small n is itself a caveat. */
  sampleSize: number;
  /** Set when value === null. The UI renders an em-dash and this reason. */
  reason?: 'no_data' | 'no_pitch_data' | 'insufficient_sample';
}

const est = <T>(value: T | null, basis: string, sampleSize: number, reason?: Estimated<T>['reason']): Estimated<T> =>
  ({ value, estimate: true, basis, sampleSize, ...(reason ? { reason } : {}) });

/** The honest empty. Renders as "—". */
const emDash = <T>(basis: string, reason: Estimated<T>['reason'] = 'no_data'): Estimated<T> =>
  est<T>(null, basis, 0, reason);

/* ─────────────────────────── Match Twin Lite (2D) ─────────────────────────── */

/** Wagon-wheel angle per zone, degrees clockwise from straight-down-the-ground. */
const ZONE_ANGLE: Record<ShotDir, number> = {
  mid_on: 20, mid_wicket: 60, square_leg: 100, fine_leg: 150,
  third_man: 210, point: 260, covers: 300, mid_off: 340,
};

export interface TwinMarker { role: 'striker' | 'non_striker' | 'bowler'; name: string; }
export interface ShotSpoke { dir: ShotDir; angle: number; runs: number; count: number; }
export interface FieldPosition { id: string; name: string; angle: number; radius: number; }

export interface MatchTwin {
  matchId: string;
  markers: TwinMarker[];
  /** Shot spokes from the EXISTING shot.dir field — real data, not inferred. */
  spokes: ShotSpoke[];
  /** Manual field placement for v0 (camera later). Empty until a captain sets it. */
  field: FieldPosition[];
  ballsUsed: number;
}

/** Build the 2D twin from match state. Markers are facts; spokes are real captured dirs. */
export function buildMatchTwin(state: MatchState, field: FieldPosition[] = []): MatchTwin {
  const byDir = new Map<ShotDir, { runs: number; count: number }>();
  for (const b of state.balls) {
    const d = b.shot?.dir;
    if (!d) continue;                       // no direction captured → contributes nothing
    const cur = byDir.get(d) ?? { runs: 0, count: 0 };
    cur.runs += b.runs; cur.count += 1;
    byDir.set(d, cur);
  }
  const spokes: ShotSpoke[] = [...byDir.entries()]
    .map(([dir, v]) => ({ dir, angle: ZONE_ANGLE[dir], runs: v.runs, count: v.count }))
    .sort((a, b) => b.runs - a.runs);

  return {
    matchId: state.matchId,
    markers: [
      { role: 'striker', name: state.striker },
      { role: 'non_striker', name: state.nonStriker },
      { role: 'bowler', name: state.bowler },
    ],
    spokes,
    field,
    ballsUsed: state.balls.filter(b => b.shot?.dir).length,
  };
}

/* ─────────────────────────── Tactical Copilot v0 ──────────────────────────── */

export interface ScoringZone { dir: ShotDir; runs: number; balls: number; strikeRate: number; }

/** Batter scoring zones (wagon-8) — real, from captured shot.dir. */
export function batterScoringZones(balls: Ball[], batter: string): Estimated<ScoringZone[]> {
  const mine = balls.filter(b => b.batter === batter && b.shot?.dir);
  if (mine.length === 0) return emDash<ScoringZone[]>('shot.dir per delivery');
  const agg = new Map<ShotDir, { runs: number; balls: number }>();
  for (const b of mine) {
    const d = b.shot!.dir!;
    const cur = agg.get(d) ?? { runs: 0, balls: 0 };
    cur.runs += b.runs; cur.balls += 1;
    agg.set(d, cur);
  }
  const zones = [...agg.entries()]
    .map(([dir, v]) => ({ dir, runs: v.runs, balls: v.balls, strikeRate: Number(((v.runs / v.balls) * 100).toFixed(1)) }))
    .sort((a, b) => b.runs - a.runs);
  return est(zones, 'shot.dir + runs per delivery (wagon-8)', mine.length);
}

export interface PressureCell { over: number; dots: number; balls: number; dotPct: number; }

/** Dot-ball pressure map per over — real, from runs/extras. */
export function dotBallPressure(balls: Ball[]): Estimated<PressureCell[]> {
  if (balls.length === 0) return emDash<PressureCell[]>('runs per delivery');
  const byOver = new Map<number, { dots: number; balls: number }>();
  for (const b of balls) {
    const cur = byOver.get(b.over) ?? { dots: 0, balls: 0 };
    cur.balls += 1;
    if (b.runs === 0 && !(b.extras ?? 0)) cur.dots += 1;
    byOver.set(b.over, cur);
  }
  const cells = [...byOver.entries()]
    .map(([over, v]) => ({ over, dots: v.dots, balls: v.balls, dotPct: Number(((v.dots / v.balls) * 100).toFixed(1)) }))
    .sort((a, b) => a.over - b.over);
  return est(cells, 'dot balls per over from scoring data', balls.length);
}

export interface LineLengthCell { line: string; length: string; balls: number; runs: number; }

/**
 * Bowler line/length effectiveness. 🔴 REQUIRES PITCH COORDINATES, WHICH ARE NOT
 * CAPTURED TODAY. The roadmap says "UI ready, fills when pitch data lands" — so this
 * returns an honest em-dash with `reason: 'no_pitch_data'` rather than inventing a map.
 */
export function bowlerLineLength(balls: Ball[], bowler: string): Estimated<LineLengthCell[]> {
  const mine = balls.filter(b => b.bowler === bowler);
  const withPitch = mine.filter(b => b.pitch && Number.isFinite(b.pitch.x) && Number.isFinite(b.pitch.y));
  if (withPitch.length === 0) {
    // The UI is ready. The data is not. Say so; do not fabricate a heat map.
    return emDash<LineLengthCell[]>('pitch.x/pitch.y per delivery (not captured yet)', 'no_pitch_data');
  }
  const agg = new Map<string, { balls: number; runs: number }>();
  for (const b of withPitch) {
    const line = b.pitch!.x < -0.2 ? 'outside_off' : b.pitch!.x > 0.2 ? 'leg' : 'stumps';
    const length = b.pitch!.y < 4 ? 'full' : b.pitch!.y < 7 ? 'good' : 'short';
    const k = `${line}|${length}`;
    const cur = agg.get(k) ?? { balls: 0, runs: 0 };
    cur.balls += 1; cur.runs += b.runs;
    agg.set(k, cur);
  }
  const cells = [...agg.entries()].map(([k, v]) => {
    const [line, length] = k.split('|');
    return { line, length, balls: v.balls, runs: v.runs };
  });
  return est(cells, 'pitch coordinates per delivery', withPitch.length);
}

export interface Matchup { batter: string; bowler: string; balls: number; runs: number; dismissals: number; strikeRate: number | null; }

/** Batter-vs-bowler matchup — real counts from scoring data. */
export function matchup(balls: Ball[], batter: string, bowler: string): Estimated<Matchup> {
  const mine = balls.filter(b => b.batter === batter && b.bowler === bowler);
  if (mine.length === 0) return emDash<Matchup>('deliveries of this batter vs this bowler');
  const runs = mine.reduce((s, b) => s + b.runs, 0);
  const dismissals = mine.filter(b => b.wicket).length;
  const m: Matchup = {
    batter, bowler, balls: mine.length, runs, dismissals,
    strikeRate: Number(((runs / mine.length) * 100).toFixed(1)),
  };
  // A 3-ball sample is not a matchup. Say the sample is thin rather than implying signal.
  return est(m, 'head-to-head deliveries from scoring data', mine.length,
    mine.length < 6 ? 'insufficient_sample' : undefined);
}

/**
 * Expected runs next over — an ESTIMATE from this match's own recent rate.
 * Deliberately simple and transparent: last-N-overs run rate. No model, no new maths.
 * Small sample → still returns the number BUT flags `insufficient_sample`; the UI shows
 * the caveat next to it.
 */
export function expectedRunsNextOver(balls: Ball[], lastNOvers = 3): Estimated<number> {
  if (balls.length === 0) return emDash<number>('recent run rate');
  const overs = [...new Set(balls.map(b => b.over))].sort((a, b) => a - b);
  const recent = overs.slice(-lastNOvers);
  const inWindow = balls.filter(b => recent.includes(b.over));
  if (inWindow.length === 0) return emDash<number>('recent run rate');
  const runs = inWindow.reduce((s, b) => s + b.runs + (b.extras ?? 0), 0);
  const perOver = runs / recent.length;
  return est(Number(perOver.toFixed(2)), `run rate over last ${recent.length} over(s)`, inWindow.length,
    inWindow.length < 12 ? 'insufficient_sample' : undefined);
}

/* ─────────────────────────── Plan vs actual ───────────────────────────────── */

export interface OverPlan {
  over: number;
  /** Captain's intended line for the over. */
  line: 'stumps' | 'outside_off' | 'leg';
  /** Field positions the captain set for this over. */
  field: FieldPosition[];
  note?: string;
}

export interface PlanVsActual {
  over: number;
  planned: { line: OverPlan['line']; fieldCount: number };
  actual: { runs: number; balls: number; ballsOffPlan: Estimated<number> };
  /** Recommended vs actual, honestly labelled. */
  verdict: Estimated<'on_plan' | 'partially_off_plan' | 'off_plan'>;
}

/**
 * Plan-vs-actual for a completed over. Runs/balls are FACTS. "Balls off plan" needs
 * pitch coordinates to know where it actually landed → em-dash until pitch data lands.
 */
export function planVsActual(plan: OverPlan, balls: Ball[]): PlanVsActual {
  const overBalls = balls.filter(b => b.over === plan.over);
  const runs = overBalls.reduce((s, b) => s + b.runs + (b.extras ?? 0), 0);
  const withPitch = overBalls.filter(b => b.pitch);

  let ballsOffPlan: Estimated<number>;
  let verdict: PlanVsActual['verdict'];
  if (withPitch.length === 0) {
    ballsOffPlan = emDash<number>('pitch coordinates per delivery (not captured yet)', 'no_pitch_data');
    verdict = emDash<'on_plan' | 'partially_off_plan' | 'off_plan'>('requires pitch coordinates', 'no_pitch_data');
  } else {
    const off = withPitch.filter(b => {
      const line = b.pitch!.x < -0.2 ? 'outside_off' : b.pitch!.x > 0.2 ? 'leg' : 'stumps';
      return line !== plan.line;
    }).length;
    ballsOffPlan = est(off, 'deliveries whose line != planned line', withPitch.length);
    const ratio = off / withPitch.length;
    verdict = est(ratio === 0 ? 'on_plan' : ratio <= 0.34 ? 'partially_off_plan' : 'off_plan',
      'share of deliveries off the planned line', withPitch.length);
  }

  return {
    over: plan.over,
    planned: { line: plan.line, fieldCount: plan.field.length },
    actual: { runs, balls: overBalls.length, ballsOffPlan },
    verdict,
  };
}

/* ─────────────────────────── Copilot rollup ───────────────────────────────── */

export interface CopilotView {
  matchId: string;
  zones: Estimated<ScoringZone[]>;
  pressure: Estimated<PressureCell[]>;
  lineLength: Estimated<LineLengthCell[]>;
  matchup: Estimated<Matchup>;
  expectedRuns: Estimated<number>;
  /** Per-match pricing hook — DARK. No charge occurs; this only records eligibility. */
  pilot: { flagged: boolean; charge: false };
}

/** One call for the Match Center panel. Every field carries its own estimate label. */
export function buildCopilot(state: MatchState, opts: { pilotFlag?: boolean } = {}): CopilotView {
  return {
    matchId: state.matchId,
    zones: batterScoringZones(state.balls, state.striker),
    pressure: dotBallPressure(state.balls),
    lineLength: bowlerLineLength(state.balls, state.bowler),
    matchup: matchup(state.balls, state.striker, state.bowler),
    expectedRuns: expectedRunsNextOver(state.balls),
    // Money is DARK: the hook records that a match is pilot-eligible; `charge` is a literal false.
    pilot: { flagged: !!opts.pilotFlag, charge: false },
  };
}
