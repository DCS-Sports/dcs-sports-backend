/**
 * COACH AI CONTRACTS — prompt builders + validated response shapes.
 *
 * Honest-scope: this defines the frozen interface only. No LLM is called until
 * DCS_LLM_ENDPOINT is set + an LLMRunner is injected. When it lands:
 *   1. buildBreakdownPrompt / buildPlanPrompt produce the grounded prompts,
 *   2. the LLM returns JSON,
 *   3. parseBreakdown / parsePlan VALIDATE it (Zod) — malformed output is
 *      rejected (fail-closed) rather than passed through as fake advice,
 *   4. numerics are wrapped in the S4 estimate envelope (source:"coach_ai").
 *
 * Coaching boundary (carried from the Dream-AI Rule S1 lesson): Coach AI is a
 * coach, not a clinician. Prompts forbid medical/diagnostic claims and require
 * the model to stay within technique/training. Anything it can't ground in the
 * provided data it must omit, not invent.
 */
import { z } from "zod";
import { makeEstimate, type Estimate } from "../lib/estimate";

// ---- grounded input the prompt is built from (real data, never invented) ----
export interface CoachContext {
  athlete_id: string;
  sport: string;
  role?: string; // batter / bowler / all-rounder
  recent_stats?: {
    matches: number;
    avg_runs?: number;
    strike_rate?: number;
    wickets?: number;
  };
  vision_summary?: {
    // optional: pulled from a Vision job (e.g. shot map / event tags)
    notable_events?: string[];
  };
  focus_areas?: string[];
}

// ---- system prompt: the boundary + output contract the model must obey ----
export const COACH_SYSTEM_PROMPT = [
  "You are DCS Coach AI, a cricket technique and training assistant.",
  "You are a COACH, not a clinician. Never give medical, injury-diagnosis, or",
  "psychological-treatment advice; if asked, defer to a qualified professional.",
  "Ground every statement in the data provided. If the data does not support a",
  "claim, omit it — do NOT invent statistics, scores, or events.",
  "Every numeric rating you output is an ESTIMATE; never present it as measured fact.",
  "Respond with ONLY valid JSON matching the requested schema. No prose, no markdown.",
].join(" ");

export function buildBreakdownPrompt(ctx: CoachContext): { system: string; user: string } {
  const user = {
    task: "breakdown",
    instruction:
      "Produce a technical breakdown. Return JSON: " +
      '{ "summary": string, "focus_areas": string[], ' +
      '"technical_scores": [{ "skill": string, "value": number(0..100), "confidence": number(0..1) }] }. ' +
      "Base scores only on the provided stats/events; if insufficient, return fewer scores with lower confidence.",
    context: ctx,
  };
  return { system: COACH_SYSTEM_PROMPT, user: JSON.stringify(user) };
}

export function buildPlanPrompt(ctx: CoachContext): { system: string; user: string } {
  const user = {
    task: "plan",
    instruction:
      "Produce a 4-week training roadmap targeting the focus areas. Return JSON: " +
      '{ "weeks": [{ "week": number, "theme": string, "drills": string[] }] }. ' +
      "Drills must be technique/fitness only — no medical or rehab prescriptions.",
    context: ctx,
  };
  return { system: COACH_SYSTEM_PROMPT, user: JSON.stringify(user) };
}

// ---- response schemas: validate the LLM output; reject malformed (fail-closed) ----
const BreakdownSchema = z.object({
  summary: z.string().min(1).max(2000),
  focus_areas: z.array(z.string().min(1)).max(12),
  technical_scores: z
    .array(
      z.object({
        skill: z.string().min(1),
        value: z.number().min(0).max(100),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(20),
});

const PlanSchema = z.object({
  weeks: z
    .array(
      z.object({
        week: z.number().int().min(1).max(52),
        theme: z.string().min(1),
        drills: z.array(z.string().min(1)).min(1).max(12),
      }),
    )
    .min(1)
    .max(52),
});

export interface BreakdownResult {
  athlete_id: string;
  summary: string;
  focus_areas: string[];
  technical_scores: Estimate[]; // each enveloped, source: coach_ai
  model_version: string;
}

export interface TrainingPlanResult {
  athlete_id: string;
  weeks: Array<{ week: number; theme: string; drills: string[] }>;
  model_version: string;
}

/** Parse + validate a breakdown response; wrap numerics in the envelope. */
export function parseBreakdown(raw: unknown, athlete_id: string, model_version: string): BreakdownResult {
  const parsed = BreakdownSchema.parse(coerceJson(raw));
  return {
    athlete_id,
    summary: parsed.summary,
    focus_areas: parsed.focus_areas,
    technical_scores: parsed.technical_scores.map((s) =>
      Object.assign(
        makeEstimate({ value: s.value, confidence: s.confidence, source: "coach_ai", model_version }),
        { skill: s.skill },
      ),
    ) as Array<Estimate & { skill: string }>,
    model_version,
  };
}

/** Parse + validate a plan response. */
export function parsePlan(raw: unknown, athlete_id: string, model_version: string): TrainingPlanResult {
  const parsed = PlanSchema.parse(coerceJson(raw));
  return { athlete_id, weeks: parsed.weeks, model_version };
}

/** LLMs sometimes wrap JSON in prose/markdown; extract the JSON object safely. */
function coerceJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  // strip ```json fences if present
  const fenced = trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(fenced);
  } catch {
    // last resort: first {...} block
    const m = fenced.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Coach AI response was not valid JSON");
  }
}

export { BreakdownSchema, PlanSchema };
