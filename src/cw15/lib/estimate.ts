/**
 * S4 ESTIMATE ENVELOPE (frozen by Day-0 manager reply).
 * Every AI numeric output ships this exact shape. No lane may emit a bare number.
 *
 * Frozen shape:
 *   { value, confidence, estimate:true, source, model_version, generated_at, human_reviewed }
 *
 * Honest-scope ruling #10: heuristic placeholders + envelope NOW; no trained
 * model/LLM in-session. Anything that REQUIRES a trained model/LLM must
 * fail-closed (modelGate) — never fabricate AI output.
 */

export type EstimateSource = "vision" | "talent" | "coach_ai" | "scout_ai";

export interface Estimate {
  value: number;
  confidence: number; // 0..1
  estimate: true;
  source: EstimateSource;
  model_version: string | null;
  generated_at: string; // ISO
  human_reviewed: boolean;
}

/**
 * Wrap a heuristic-derived number in the frozen envelope.
 * `model_version` is null for heuristic outputs — that is the honest signal
 * that no trained model produced this. UI renders "estimate".
 */
export function makeEstimate(params: {
  value: number;
  confidence: number;
  source: EstimateSource;
  model_version?: string | null;
}): Estimate {
  const confidence = clamp01(params.confidence);
  return {
    value: round(params.value),
    confidence: round(confidence),
    estimate: true,
    source: params.source,
    model_version: params.model_version ?? null,
    generated_at: new Date().toISOString(),
    human_reviewed: false,
  };
}

/**
 * Fail-closed gate for any path that REQUIRES a trained CV model or LLM.
 * Per ruling #10 these are DARK until DK provisions them. We never fabricate;
 * we surface a structured "model unavailable" state the UI can render honestly.
 */
export class ModelUnavailableError extends Error {
  readonly code = "MODEL_UNAVAILABLE";
  constructor(
    public readonly capability: string,
    public readonly requires: "cv_model" | "llm",
  ) {
    super(
      `${capability} requires a ${requires} which is not provisioned (DARK). ` +
        `Fail-closed per honest-scope ruling #10 — no AI output fabricated.`,
    );
    this.name = "ModelUnavailableError";
  }
}

/** True only when an env var carrying the model/LLM endpoint is actually set. */
export function modelGate(requires: "cv_model" | "llm"): {
  available: boolean;
  endpoint: string | null;
} {
  const key = requires === "cv_model" ? "DCS_VISION_MODEL_URL" : "DCS_LLM_ENDPOINT";
  const endpoint = process.env[key]?.trim() || null;
  return { available: !!endpoint, endpoint };
}

/** Thrown when an admin-only route is called without admin privileges. */
export class AdminRequiredError extends Error {
  readonly code = "ADMIN_REQUIRED";
  constructor() {
    super("This action requires an admin role.");
    this.name = "AdminRequiredError";
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
