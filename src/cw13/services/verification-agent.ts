// CW13 — Verification AI agent (module 4.4 / R4: "anomaly flag -> human sign-off, 80/20").
// Runs a HEURISTIC anomaly assessment over submitted evidence + claimed signals,
// emits the FROZEN S4 estimate envelope, and writes a high-stakes suggestion to
// sports_agent_suggestions for a human verifier to action.
//
// HARD RULES (honest-scope):
//   - This NEVER approves or rejects anything. It only flags + suggests.
//   - Output is estimate-labeled (heuristic, model_version:null) — no trained
//     model in-session. Flips to a real model when DK provisions one.
//   - The verifier decides; the suggestion is advisory (high_stakes:true).

import type { EstimateEnvelope, EntityType } from '../lib/contracts';
import { writeSuggestion, type AgentSuggestion } from './agent-repo';

export interface AnomalySignal {
  // raw inputs the agent reasons over (supplied by the submit flow / CW12 data)
  has_evidence: boolean;            // an evidence_url was attached
  claimed_value?: number;          // e.g. a claimed rating/stat being verified
  peer_median?: number;            // median of comparable verified peers
  submissions_last_30d?: number;   // burst of submissions from same submitter
  evidence_age_days?: number;      // staleness of the evidence
}

export interface AnomalyAssessment {
  flagged: boolean;
  reasons: string[];
  risk: EstimateEnvelope;          // value = anomaly risk 0..1
}

export function assessAnomaly(signal: AnomalySignal): AnomalyAssessment {
  const reasons: string[] = [];
  let risk = 0;

  if (!signal.has_evidence) {
    risk += 0.55;
    reasons.push('No supporting evidence attached.');
  }
  if (signal.claimed_value != null && signal.peer_median != null && signal.peer_median > 0) {
    const ratio = signal.claimed_value / signal.peer_median;
    if (ratio >= 2) {
      risk += 0.35;
      reasons.push(`Claimed value is ${ratio.toFixed(1)}× the verified peer median.`);
    } else if (ratio >= 1.5) {
      risk += 0.2;
      reasons.push(`Claimed value is well above the verified peer median.`);
    }
  }
  if ((signal.submissions_last_30d ?? 0) >= 5) {
    risk += 0.15;
    reasons.push('High submission frequency from this source in the last 30 days.');
  }
  if ((signal.evidence_age_days ?? 0) > 365) {
    risk += 0.1;
    reasons.push('Evidence is over a year old.');
  }

  risk = Math.min(1, risk);
  const flagged = risk >= 0.5;

  // confidence: heuristic is more confident at the extremes, less in the middle
  const confidence = Math.round((0.5 + Math.abs(risk - 0.5)) * 100) / 100;

  const riskEnvelope: EstimateEnvelope = {
    value: Math.round(risk * 1000) / 1000,
    confidence,
    estimate: true,
    source: 'scout_ai', // closest frozen enum value for a verification-side heuristic
    model_version: null,
    generated_at: new Date().toISOString(),
    human_reviewed: false,
  };

  return { flagged, reasons: reasons.length ? reasons : ['No anomalies detected by heuristic.'], risk: riskEnvelope };
}

// Run the agent for a verification and record a high-stakes suggestion for a
// human verifier. Returns both the assessment and the written suggestion.
// Does NOT change verification status — the verifier acts in the queue.
export async function runVerificationAgent(
  verificationId: string,
  entityType: EntityType,
  signal: AnomalySignal
): Promise<{ assessment: AnomalyAssessment; suggestion: AgentSuggestion }> {
  const assessment = assessAnomaly(signal);
  const suggestion = await writeSuggestion({
    agent: 'verification_ai',
    subject_type: entityType,
    subject_id: verificationId,
    high_stakes: true,
    payload_json: {
      recommended_action: assessment.flagged ? 'human_review_required' : 'human_review_routine',
      anomaly_risk: assessment.risk,
      reasons: assessment.reasons,
    },
  });
  return { assessment, suggestion };
}
