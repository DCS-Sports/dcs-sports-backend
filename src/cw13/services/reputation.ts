// CW13 — Reputation Engine (v3.0).
// Trust scores for athlete/coach/academy/league/scout, derived STRICTLY from
// signed, human-verified events. No self-reported inputs an entity could inflate.
//
// HONEST-SCOPE (hard):
//   - Estimate-labeled. A trust score is a heuristic over verified events; it
//     ships the S4 envelope (estimate:true, confidence, model_version:null) and
//     does not drop the "estimate" label until a published validation gate is met.
//   - Inputs are ONLY signed verified events (status human_verified with a valid
//     receipt). Revocations subtract. Nothing else feeds the score.
//   - ANTI-GAMING: score rewards DIVERSITY of independent verifiers and is
//     capped per-verifier, so you cannot farm a high score by spamming many
//     low-value events from one colluding verifier. Recency-weighted so stale
//     reputation decays. Revoked events apply a penalty.
//
// This is reputation FROM verification — CW13's own signal. Other lanes' signals
// (match performance, scout interest) are NOT mixed in here; that's CW14/CW16's
// graph. Keeping it pure makes the anti-gaming property auditable.

import type { EstimateEnvelope } from '../lib/contracts';
import type { VerificationRow } from '../lib/contracts';
import { decodeReceipt } from '../lib/receipt-chain';
import { listAll } from './verification-repo';

export interface ReputationInputs {
  verified_events: number;       // signed human_verified events for this entity
  distinct_verifiers: number;    // independent verifiers who attested (diversity)
  revocations: number;           // signed revoke events (penalty)
  most_recent_at: string | null;
  oldest_at: string | null;
}

export interface ReputationScore {
  entity_type: string;
  entity_id: string;
  score: EstimateEnvelope;       // value 0..1, estimate-labeled
  inputs: ReputationInputs;
  factors: {
    volume: number;              // saturating in event count, 0..1
    diversity: number;           // distinct independent verifiers, 0..1 (anti-gaming)
    recency: number;             // decay since most-recent verified event, 0..1
    penalty: number;             // from revocations, 0..1 subtracted
  };
}

const HALF_LIFE_DAYS = 365; // reputation recency half-life

// Compute reputation for one entity from its verified events.
export function scoreFromRows(
  entityType: string,
  entityId: string,
  rows: VerificationRow[],
  now: Date = new Date()
): ReputationScore {
  const mine = rows.filter((r) => r.entity_type === entityType && r.entity_id === entityId);

  const verifies: VerificationRow[] = [];
  const revokes: VerificationRow[] = [];
  const verifierSet = new Set<string>();

  for (const r of mine) {
    if (!r.sig) continue;
    const d = decodeReceipt(r.sig);
    if (!d || !d.receipt_hash) continue; // only genuinely signed events count
    if (d.kind === 'revoke') {
      revokes.push(r);
    } else {
      verifies.push(r);
      if (r.verified_by) verifierSet.add(r.verified_by);
    }
  }

  const inputs: ReputationInputs = {
    verified_events: verifies.length,
    distinct_verifiers: verifierSet.size,
    revocations: revokes.length,
    most_recent_at: verifies.length ? verifies[verifies.length - 1].ts : null,
    oldest_at: verifies.length ? verifies[0].ts : null,
  };

  // volume: saturating — diminishing returns, so spamming events can't run away.
  const volume = clamp01(1 - Math.exp(-verifies.length / 4));

  // diversity (ANTI-GAMING): driven by INDEPENDENT verifiers, not raw count.
  // One verifier attesting 50 times => diversity stays low.
  const diversity = clamp01(1 - Math.exp(-verifierSet.size / 2));

  // recency: decay since the most recent verified event.
  let recency = 0;
  if (inputs.most_recent_at) {
    const days = (now.getTime() - new Date(inputs.most_recent_at).getTime()) / 864e5;
    recency = clamp01(Math.pow(0.5, days / HALF_LIFE_DAYS));
  }

  // penalty: each revocation hurts; saturating.
  const penalty = clamp01(1 - Math.exp(-revokes.length / 2));

  // composite: diversity weighted highest (the anti-gaming signal), then volume,
  // gated by recency, minus penalty.
  const base = 0.5 * diversity + 0.3 * volume + 0.2 * recency * (volume > 0 ? 1 : 0);
  const value = clamp01(base * (1 - 0.6 * penalty));

  // confidence scales with how much signed evidence exists (events + verifiers).
  const confidence = clamp01(Math.min(0.9, 0.2 + 0.1 * verifies.length + 0.1 * verifierSet.size));

  const score: EstimateEnvelope = {
    value: round(value),
    confidence: round(confidence),
    estimate: true,
    source: 'talent', // closest frozen enum; reputation is a CW13 heuristic
    model_version: null, // heuristic — does NOT leave "estimate" until the gate
    generated_at: now.toISOString(),
    human_reviewed: false,
  };

  return {
    entity_type: entityType,
    entity_id: entityId,
    score,
    inputs,
    factors: { volume: round(volume), diversity: round(diversity), recency: round(recency), penalty: round(penalty) },
  };
}

// Reputation for a single entity (reads all rows, filters to the entity).
export async function reputation(entityType: string, entityId: string): Promise<ReputationScore> {
  const rows = await listAll();
  return scoreFromRows(entityType, entityId, rows, new Date());
}

// Leaderboard for an entity type, ranked by reputation (admin/federation view).
export async function reputationBoard(entityType: string, limit = 20): Promise<ReputationScore[]> {
  const rows = await listAll();
  const ids = new Set(rows.filter((r) => r.entity_type === entityType).map((r) => r.entity_id));
  const now = new Date();
  return [...ids]
    .map((id) => scoreFromRows(entityType, id, rows, now))
    .filter((s) => s.inputs.verified_events > 0)
    .sort((a, b) => b.score.value - a.score.value)
    .slice(0, limit);
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number) => Math.round(n * 1000) / 1000;
