/**
 * 4.11 COACH AI — video breakdown -> training roadmap.
 *
 * Fully scaffolded, fail-closed until DK provisions DCS_LLM_ENDPOINT AND an
 * LLMRunner is injected. The contract layer (coach-ai-contracts.ts) builds
 * grounded prompts, validates the LLM response (malformed -> reject, never
 * fabricate), and wraps numerics in the S4 estimate envelope.
 *
 * Lights up with a single injection — like Vision V3/V4. Zero surface changes.
 */
import { modelGate, ModelUnavailableError } from "../lib/estimate";
import type { DBPort } from "../db/port";
import {
  buildBreakdownPrompt,
  buildPlanPrompt,
  parseBreakdown,
  parsePlan,
  type CoachContext,
  type BreakdownResult,
  type TrainingPlanResult,
} from "./coach-ai-contracts";

export type { BreakdownResult, TrainingPlanResult } from "./coach-ai-contracts";

/**
 * The LLM seam. Provide at deploy (wrapping the real inference endpoint) to
 * light up Coach AI. Returns the raw model text/JSON; the service validates it.
 */
export type LLMRunner = (input: {
  endpoint: string;
  system: string;
  user: string;
}) => Promise<unknown>;

export class CoachAIService {
  constructor(
    private db?: DBPort,
    private llmRunner?: LLMRunner,
  ) {}

  /** Analyze an athlete into a technical breakdown. Fail-closed. */
  async analyze(input: { athlete_id: string; vision_job_id?: string }): Promise<BreakdownResult> {
    const gate = modelGate("llm");
    if (!gate.available || !this.llmRunner) {
      throw new ModelUnavailableError("Coach AI breakdown", "llm");
    }
    const ctx = await this.buildContext(input.athlete_id, undefined, input.vision_job_id);
    const { system, user } = buildBreakdownPrompt(ctx);
    const raw = await this.llmRunner({ endpoint: gate.endpoint!, system, user });
    const modelVersion = process.env.DCS_LLM_MODEL_VERSION || "llm-unspecified";
    return parseBreakdown(raw, input.athlete_id, modelVersion);
  }

  /** Generate a 4-week training roadmap. Fail-closed. */
  async plan(input: { athlete_id: string; focus_areas?: string[] }): Promise<TrainingPlanResult> {
    const gate = modelGate("llm");
    if (!gate.available || !this.llmRunner) {
      throw new ModelUnavailableError("Coach AI training plan", "llm");
    }
    const ctx = await this.buildContext(input.athlete_id, input.focus_areas);
    const { system, user } = buildPlanPrompt(ctx);
    const raw = await this.llmRunner({ endpoint: gate.endpoint!, system, user });
    const modelVersion = process.env.DCS_LLM_MODEL_VERSION || "llm-unspecified";
    return parsePlan(raw, input.athlete_id, modelVersion);
  }

  /**
   * Build grounded context from real data. Coaching prompts are only as honest
   * as their inputs — we pull real match performances; if the DB isn't wired,
   * context is minimal (the model is told to lower confidence accordingly).
   */
  private async buildContext(
    athleteId: string,
    focusAreas?: string[],
    _visionJobId?: string,
  ): Promise<CoachContext> {
    const ctx: CoachContext = { athlete_id: athleteId, sport: "cricket", focus_areas: focusAreas };
    if (this.db) {
      const perfs = await this.db.getMatchPerformances(athleteId);
      if (perfs.length > 0) {
        const runs = perfs.reduce((s, p) => s + p.runs, 0);
        const balls = perfs.reduce((s, p) => s + p.balls, 0) || 1;
        const wickets = perfs.reduce((s, p) => s + p.wickets, 0);
        ctx.recent_stats = {
          matches: perfs.length,
          avg_runs: Math.round((runs / perfs.length) * 10) / 10,
          strike_rate: Math.round((runs / balls) * 100 * 10) / 10,
          wickets,
        };
      }
    }
    return ctx;
  }
}
