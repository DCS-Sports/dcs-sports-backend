/**
 * MODEL-LIVE VALIDATION GATE (v3.0 headline).
 *
 * The honest mechanism that decides whether an AI capability is allowed to drop
 * the "estimate" label. A number becomes "validated" ONLY when a backtest
 * publishes accuracy + confidence + sample size that clears a PUBLISHED bar.
 * Until then everything stays estimate-labeled — no silent promotions.
 *
 * This is the deepest expression of the lane's honest-scope rule: AI output is
 * an estimate until proven, and "proven" has an auditable, published definition.
 *
 * Nothing here flips a model on its own. It reports whether the bar is met and
 * records the validation evidence; a human (DK) makes the final go-live call.
 */

export interface ValidationBar {
  capability: string; // e.g. "selection_probability", "talent_index"
  /** Minimum accuracy metric the backtest must reach (e.g. AUC, hit-rate). 0..1 */
  min_accuracy: number;
  /** Minimum sample size the backtest must cover. */
  min_samples: number;
  /** Minimum confidence (1 - p) or calibration floor. 0..1 */
  min_confidence: number;
  metric_name: string; // human-readable: "AUC", "top-k hit rate", ...
}

/** The published bars. Visible + auditable; changing them is a deliberate act. */
export const VALIDATION_BARS: Record<string, ValidationBar> = {
  selection_probability: {
    capability: "selection_probability",
    min_accuracy: 0.75,
    min_samples: 500,
    min_confidence: 0.8,
    metric_name: "AUC",
  },
  talent_index: {
    capability: "talent_index",
    min_accuracy: 0.7,
    min_samples: 1000,
    min_confidence: 0.8,
    metric_name: "Spearman vs outcomes",
  },
};

export interface BacktestEvidence {
  capability: string;
  accuracy: number; // measured metric value 0..1
  samples: number;
  confidence: number; // 0..1
  evaluated_at: string; // ISO
  notes?: string;
}

export interface GateVerdict {
  capability: string;
  /** True only if every published threshold is met. */
  validated: boolean;
  /** Per-criterion pass/fail so the verdict is auditable. */
  checks: Array<{ name: string; required: number; actual: number; pass: boolean }>;
  bar: ValidationBar;
  evidence: BacktestEvidence;
  /** The label any output of this capability MUST currently wear. */
  label: "estimate" | "validated";
}

/**
 * Evaluate backtest evidence against the published bar. Pure + deterministic.
 * `validated` is true only when ALL criteria pass; otherwise the capability
 * stays "estimate". There is no partial credit and no override here.
 */
export function evaluateGate(evidence: BacktestEvidence): GateVerdict {
  const bar = VALIDATION_BARS[evidence.capability];
  if (!bar) {
    // Unknown capability => can never be "validated" through this gate.
    return {
      capability: evidence.capability,
      validated: false,
      checks: [{ name: "known_capability", required: 1, actual: 0, pass: false }],
      bar: {
        capability: evidence.capability,
        min_accuracy: 1,
        min_samples: Infinity,
        min_confidence: 1,
        metric_name: "n/a",
      },
      evidence,
      label: "estimate",
    };
  }
  const checks = [
    { name: bar.metric_name, required: bar.min_accuracy, actual: evidence.accuracy, pass: evidence.accuracy >= bar.min_accuracy },
    { name: "samples", required: bar.min_samples, actual: evidence.samples, pass: evidence.samples >= bar.min_samples },
    { name: "confidence", required: bar.min_confidence, actual: evidence.confidence, pass: evidence.confidence >= bar.min_confidence },
  ];
  const validated = checks.every((c) => c.pass);
  return { capability: evidence.capability, validated, checks, bar, evidence, label: validated ? "validated" : "estimate" };
}

/**
 * In-process registry of the latest verdict per capability. Defaults to
 * estimate (no evidence => not validated). CW16/DK push backtest evidence here
 * via the admin route; outputs read the current label from here.
 */
class GateRegistry {
  private verdicts = new Map<string, GateVerdict>();

  record(evidence: BacktestEvidence): GateVerdict {
    const verdict = evaluateGate(evidence);
    this.verdicts.set(evidence.capability, verdict);
    return verdict;
  }

  /** The label a capability's output must wear right now. Defaults to "estimate". */
  labelFor(capability: string): "estimate" | "validated" {
    return this.verdicts.get(capability)?.label ?? "estimate";
  }

  verdictFor(capability: string): GateVerdict | null {
    return this.verdicts.get(capability) ?? null;
  }

  all(): GateVerdict[] {
    return [...this.verdicts.values()];
  }
}

export const gateRegistry = new GateRegistry();
