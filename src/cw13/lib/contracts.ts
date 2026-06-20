// CW13 — contract types frozen against the Day-0 Manager Reply (S1, S4).
// Do not widen these without a [contract-change] sign-off from the CW manager.

export type EntityType = 'athlete' | 'academy' | 'coach' | 'league' | 'scout';

// S1: sports_verifications.status check in(...)
export type VerificationStatus =
  | 'pending'        // evidence submitted, no review yet
  | 'ai_passed'      // anomaly/AI check passed — NOT a badge yet (human-in-loop required)
  | 'human_verified' // a verifier human-confirmed — badge issues, sig written
  | 'rejected';

// S1: sports_verifications row
export interface VerificationRow {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  status: VerificationStatus;
  verified_by: string | null;   // verifier user_id; null until human action
  evidence_url: string | null;
  ts: string;                    // iso
  sig: string | null;            // ed25519 receipt sig — only on human_verified
}

// S4: estimate envelope — every AI numeric output ships exactly this shape.
export interface EstimateEnvelope {
  value: number;
  confidence: number;            // 0..1
  estimate: true;
  source: 'vision' | 'talent' | 'coach_ai' | 'scout_ai';
  model_version: string | null;
  generated_at: string;          // iso
  human_reviewed: boolean;
}

// S4: ed25519 receipt (reuse Atlas — interface only here)
export interface ReceiptInput {
  subject_type: string;
  subject_id: string;
  attestation: string;
  attested_by: string;
  prev_hash: string | null;
}

export interface Receipt extends ReceiptInput {
  receipt_hash: string;
  sig: string;
}
