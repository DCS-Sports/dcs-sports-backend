/**
 * src/routes/fusion.ts — Assisted Scoring Fusion.  CW3 · DCS Sports · 16 Jul 2026
 *
 * Scorer input × camera events → agreement/disagreement engine.
 *
 * Built against the REAL schemas (manager reply §2/§3), no adapter indirection:
 *   sports_live_scores    : match_id, innings, over, ball, event_json, ts
 *   sports_tracked_events : id, match_id, type, over, ball, athlete_id, confidence, estimate, data_json, created_at
 *
 * 🔴 THE INVARIANT: NO AUTONOMOUS SCORING.
 *   DISAGREE and CAMERA_ONLY always terminate at a human action.
 *   AGREE may be marked "ready to confirm" — it still requires the official's click.
 *   Nothing in this module writes to sports_live_scores. Resolution goes through the EXISTING
 *   resolve endpoint (POST /matches/:id/tracked-events/:eid/resolve) — we do not build a second
 *   resolution path.
 *
 * Every fusion decision emits ONE R+2 receipt (frozen primitive, injected — see §4 of the reply).
 * Money/autonomy DARK. Every camera-derived value stays estimate-labelled.
 */

// ── real row types (verbatim from the production schema) ──────────────────────
export interface ScorerBallRow {
  match_id: string;
  innings: 1 | 2;
  over: number;              // 0-based
  ball: number;              // 1-based
  event_json: ScorerEventJson;
  ts: string;                // timestamptz
}

export interface ScorerEventJson {
  kind: 'rich';
  innings: 1 | 2;
  over: number;
  ball: number;
  striker?: { name: string; id?: string } | null;
  non_striker?: { name: string } | null;
  bowler?: { name: string } | null;
  runs: number;
  extra?: { type: 'wd' | 'nb' | 'b' | 'lb'; runs: number } | null;
  wicket?: { how: string; out: string; fielder?: string } | null;
  shot?: { dir: number } | null;
  pitch?: { x: number; y: number } | null;
  ts: string;
  /** set by the resolve endpoint when a camera event is confirmed into the scorecard */
  from_camera?: boolean;
}

export interface TrackedEventRow {
  id: string;
  match_id: string;
  type: string;              // boundary|four|six|catch|wicket|…
  over: number;
  ball: number;
  athlete_id: string | null;
  confidence: number;        // 0..1
  estimate: boolean;         // true until resolved
  data_json: Record<string, unknown> & {
    resolved?: 'confirmed' | 'rejected';
    resolved_by?: string;
    resolved_at?: string;
  };
  created_at: string;
}

/** Legal-ball rule used everywhere in the codebase (manager reply §2). */
export const isLegal = (e: ScorerEventJson): boolean =>
  !e.extra || (e.extra.type !== 'wd' && e.extra.type !== 'nb');

// ── fusion states ────────────────────────────────────────────────────────────
export type FusionState = 'AGREE' | 'DISAGREE' | 'CAMERA_ONLY' | 'SCORER_ONLY';

export interface FusionDecision {
  match_id: string;
  delivery: { innings: 1 | 2 | null; over: number; ball: number };
  state: FusionState;
  /** sha256 of the canonical scorer event body (receipt links to it, not the raw row). */
  scorer_event_hash: string | null;
  camera_event_id: string | null;
  /** camera's implied outcome + confidence — ALWAYS estimate-labelled while estimate=true. */
  camera: { type: string; implied: ImpliedOutcome | null; confidence: number; estimate: boolean } | null;
  /** what the scorer recorded */
  scorer: { runs: number; extra: string | null; wicket: boolean } | null;
  /** why the states differ — plain language for the officials queue. */
  reason: string;
  /** DISAGREE/CAMERA_ONLY require a human. AGREE is "ready to confirm" — still a click. */
  requires_official: boolean;
  /** true only when the camera event's innings could not be established from ts (a finding). */
  innings_unresolved: boolean;
}

/** What a camera event type implies on the scorecard (mirrors the resolve endpoint's mapping). */
export type ImpliedOutcome = { runs: number } | { dismissal: true };

/**
 * Camera type → scorecard outcome. This mirrors the EXISTING resolve endpoint (§3):
 * four/boundary→4, six→6, catch/wicket→dismissal. Kept identical on purpose: if fusion
 * implied something different from what confirming would actually write, the strip would lie.
 */
export function impliedOutcome(type: string): ImpliedOutcome | null {
  const t = type.toLowerCase();
  if (t === 'four' || t === 'boundary') return { runs: 4 };
  if (t === 'six') return { runs: 6 };
  if (t === 'catch' || t === 'wicket') return { dismissal: true };
  return null; // unknown camera type implies nothing — never guess a score
}

export interface FusionConfig {
  /** ± window (ms) for matching a camera event to a scorer ball by time. */
  windowMs: number;
  /** Below this, a camera-only event is still queued but flagged low-confidence. */
  lowConfidence: number;
}
export const DEFAULT_FUSION: FusionConfig = { windowMs: 90_000, lowConfidence: 0.6 };

// ── the engine ───────────────────────────────────────────────────────────────
/**
 * fuseDelivery — decide the state for ONE (scorer ball, camera event) candidate pair.
 * Either side may be null (that is what produces SCORER_ONLY / CAMERA_ONLY).
 */
export function fuseDelivery(
  scorerRow: ScorerBallRow | null,
  camera: TrackedEventRow | null,
  hashScorerEvent: (e: ScorerEventJson) => string,
  cfg: FusionConfig = DEFAULT_FUSION,
): FusionDecision {
  if (!scorerRow && !camera) throw new Error('fuseDelivery: at least one side required');

  const match_id = (scorerRow?.match_id ?? camera!.match_id);
  const over = scorerRow?.over ?? camera!.over;
  const ball = scorerRow?.ball ?? camera!.ball;
  const innings = scorerRow?.innings ?? null; // tracked_events has NO innings column (see FINDING)

  const cameraView = camera ? {
    type: camera.type,
    implied: impliedOutcome(camera.type),
    confidence: camera.confidence,
    estimate: camera.estimate,
  } : null;

  const scorerView = scorerRow ? {
    runs: scorerRow.event_json.runs,
    extra: scorerRow.event_json.extra?.type ?? null,
    wicket: !!scorerRow.event_json.wicket,
  } : null;

  // ── SCORER_ONLY: the scorer recorded a ball no camera event corroborates.
  if (scorerRow && !camera) {
    return {
      match_id, delivery: { innings, over, ball },
      state: 'SCORER_ONLY',
      scorer_event_hash: hashScorerEvent(scorerRow.event_json),
      camera_event_id: null,
      camera: null, scorer: scorerView,
      reason: 'Scorer recorded this delivery; no camera event matched it.',
      requires_official: false, // the scorer IS the official record — nothing to resolve
      innings_unresolved: false,
    };
  }

  // ── CAMERA_ONLY: a camera event with no scorer ball. NEVER auto-scored.
  if (!scorerRow && camera) {
    const low = camera.confidence < cfg.lowConfidence;
    return {
      match_id, delivery: { innings: null, over, ball },
      state: 'CAMERA_ONLY',
      scorer_event_hash: null,
      camera_event_id: camera.id,
      camera: cameraView, scorer: null,
      reason: low
        ? `Camera detected ${camera.type} (est. ${pct(camera.confidence)}, low confidence) with no scorer entry — official review required.`
        : `Camera detected ${camera.type} (est. ${pct(camera.confidence)}) with no scorer entry — official review required.`,
      requires_official: true,   // a human decides; we never write a score from a camera alone
      innings_unresolved: true,  // no scorer row ⇒ innings cannot be established from the row
    };
  }

  // ── both present: AGREE or DISAGREE
  const s = scorerRow!, c = camera!;
  const implied = impliedOutcome(c.type);
  const agree = outcomesAgree(s.event_json, implied);

  if (agree) {
    return {
      match_id, delivery: { innings, over, ball },
      state: 'AGREE',
      scorer_event_hash: hashScorerEvent(s.event_json),
      camera_event_id: c.id,
      camera: cameraView, scorer: scorerView,
      reason: `Scorer and camera agree (camera: ${c.type}, est. ${pct(c.confidence)}).`,
      requires_official: false, // "ready to confirm" — the official still clicks. Never auto.
      innings_unresolved: false,
    };
  }

  return {
    match_id, delivery: { innings, over, ball },
    state: 'DISAGREE',
    scorer_event_hash: hashScorerEvent(s.event_json),
    camera_event_id: c.id,
    camera: cameraView, scorer: scorerView,
    reason: describeDisagreement(s.event_json, c),
    requires_official: true,     // ALWAYS terminates at a human
    innings_unresolved: false,
  };
}

/** Do the scorer's record and the camera's implied outcome describe the same delivery? */
function outcomesAgree(e: ScorerEventJson, implied: ImpliedOutcome | null): boolean {
  if (!implied) return false;                        // unknown camera type ⇒ cannot agree
  if ('dismissal' in implied) return !!e.wicket;     // camera says out; scorer must have a wicket
  if (e.wicket) return false;                        // camera says runs, scorer says wicket
  return e.runs === implied.runs;                    // 4 vs 4, 6 vs 6
}

function describeDisagreement(e: ScorerEventJson, c: TrackedEventRow): string {
  const implied = impliedOutcome(c.type);
  const scorerSaid = e.wicket ? 'wicket' : `${e.runs}`;
  const cameraSaid = !implied ? c.type
    : 'dismissal' in implied ? 'dismissal' : `${implied.runs}`;
  return `Scorer ${scorerSaid} vs camera ${cameraSaid} (est. ${pct(c.confidence)}) — official review required.`;
}

const pct = (c: number) => `${Math.round(c * 100)}%`;

// ── matching ─────────────────────────────────────────────────────────────────
/**
 * fuseMatch — pair every scorer ball with at most one camera event and produce the full strip.
 *
 * Matching key: (match_id, innings, over, ball) + a ts window (manager reply §6).
 * over.ball REPEATS for wd/nb re-balls (two rows can share over.ball) — so ts is load-bearing,
 * not a tiebreak: among candidates on the same over.ball we take the NEAREST in time, and each
 * camera event is consumed at most once.
 *
 * 🔴 FINDING (surfaced, not papered over): `sports_tracked_events` has NO innings column. When
 * both innings are present, an over.ball exists twice, and the camera row alone cannot say which.
 * We attribute by ts proximity — and when a camera event is outside every scorer ball's window
 * it becomes CAMERA_ONLY with `innings_unresolved: true` rather than being guessed into an innings.
 * See HANDOFF: the durable fix is an innings column on sports_tracked_events (migration for DK).
 */
export function fuseMatch(
  scorerRows: ScorerBallRow[],
  cameraRows: TrackedEventRow[],
  hashScorerEvent: (e: ScorerEventJson) => string,
  cfg: FusionConfig = DEFAULT_FUSION,
): FusionDecision[] {
  // Build EVERY in-window candidate pair, then commit them NEAREST-IN-TIME FIRST (global, not
  // scorer-order). Greedy-in-scorer-order is wrong here: on a wd re-ball two scorer rows share
  // over.ball, and the earlier row (the wide) would consume a camera event that is 41s away
  // while the re-ball 1s away is left unpaired. Nearest-first gives the event to the delivery it
  // actually belongs to. Each scorer row and each camera event is used at most once.
  const pairs: Array<{ si: number; c: TrackedEventRow; dt: number }> = [];
  scorerRows.forEach((s, si) => {
    const st = Date.parse(s.ts);
    for (const c of cameraRows) {
      if (c.match_id !== s.match_id || c.over !== s.over || c.ball !== s.ball) continue;
      const dt = Math.abs(Date.parse(c.created_at) - st);
      if (Number.isFinite(dt) && dt <= cfg.windowMs) pairs.push({ si, c, dt });
    }
  });
  pairs.sort((a, b) => a.dt - b.dt);

  const takenScorer = new Set<number>();
  const takenCamera = new Set<string>();
  const pairedWith = new Map<number, TrackedEventRow>();
  for (const p of pairs) {
    if (takenScorer.has(p.si) || takenCamera.has(p.c.id)) continue;
    takenScorer.add(p.si);
    takenCamera.add(p.c.id);
    pairedWith.set(p.si, p.c);
  }

  const out: FusionDecision[] = scorerRows.map((s, si) =>
    fuseDelivery(s, pairedWith.get(si) ?? null, hashScorerEvent, cfg));

  // camera events that matched no scorer ball → CAMERA_ONLY (never auto-scored)
  for (const c of cameraRows) {
    if (takenCamera.has(c.id)) continue;
    out.push(fuseDelivery(null, c, hashScorerEvent, cfg));
  }
  return out;
}

/** The disagreement queue the officials console consumes (deep-links to the DRS · Officials tab). */
export function disagreementQueue(decisions: FusionDecision[]): FusionDecision[] {
  return decisions
    .filter(d => d.requires_official)
    .filter(d => !(d.camera && (d.camera as any).resolved))  // already resolved events drop out
    .sort((a, b) => (a.delivery.over - b.delivery.over) || (a.delivery.ball - b.delivery.ball));
}

// ── receipts (frozen R+2 primitive — INJECTED, never reimplemented) ──────────
/**
 * The receipt body for one fusion decision (manager reply §4, envelope coordinated with CW6).
 * We build the BODY here; the signing/hashing/chaining is the frozen primitive, injected.
 */
export interface FusionReceiptBody {
  match_id: string;
  delivery: { innings: 1 | 2 | null; over: number; ball: number };
  scorer_event_hash: string | null;
  camera_event_id: string | null;
  state: FusionState;
  resolution?: 'confirmed' | 'rejected';
  decided_by: string;
}

export function fusionReceiptBody(d: FusionDecision, decided_by: string, resolution?: 'confirmed' | 'rejected'): FusionReceiptBody {
  const body: FusionReceiptBody = {
    match_id: d.match_id,
    delivery: d.delivery,
    scorer_event_hash: d.scorer_event_hash,
    camera_event_id: d.camera_event_id,
    state: d.state,
    decided_by,
  };
  if (resolution) body.resolution = resolution;
  return body;
}

/**
 * emitFusionReceipts — one receipt per fusion decision, via the injected R+2 primitive.
 * `emit(body) -> { receipt_id, hash, prev_hash, verified_by }` is the frozen Sports primitive
 * (ed25519 over canonical sorted-key JSON, sha256 content hash, prev_hash chain, verified_by).
 * NO new crypto here — if the primitive is absent we throw rather than invent one.
 */
export async function emitFusionReceipts(
  decisions: FusionDecision[],
  emit: (body: FusionReceiptBody) => Promise<{ receipt_id: string; hash: string }>,
  decided_by = 'fusion-engine',
): Promise<Array<{ decision: FusionDecision; receipt_id: string; hash: string }>> {
  if (typeof emit !== 'function') throw new Error('fusion: the R+2 emit primitive must be injected — no new crypto');
  const out = [];
  for (const d of decisions) {
    const r = await emit(fusionReceiptBody(d, decided_by));
    out.push({ decision: d, receipt_id: r.receipt_id, hash: r.hash });
  }
  return out;
}

export const FUSION_CONTRACT = Object.freeze({
  version: 'sports-fusion/v1',
  states: ['AGREE', 'DISAGREE', 'CAMERA_ONLY', 'SCORER_ONLY'],
  invariant: 'no autonomous scoring — DISAGREE and CAMERA_ONLY always terminate at a human action; AGREE is ready-to-confirm, still a click',
  resolution_path: 'the EXISTING POST /matches/:id/tracked-events/:eid/resolve — no second resolution path',
  wording: 'tamper-evident (not proof); every camera-derived value estimate-labelled while estimate=true',
});
