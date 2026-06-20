/**
 * 4.12 PERFORMANCE LAB — fitness tests (NO AI gate — buildable now).
 * Pure data + transparent normalization. Feeds Talent Index's fitnessScore.
 *
 * Normalization is reference-table based (documented), NOT AI — so no envelope
 * needed for raw values; the derived fitnessScore is a plain transparent number.
 */
import type { DBPort, FitnessTest } from "../db/port";

/**
 * Reference bands per test type. `betterDirection` says whether higher or lower
 * raw values are better. These are coaching-grade reference ranges; tune freely.
 */
interface RefBand {
  unit: string;
  betterDirection: "higher" | "lower";
  floor: number; // maps to 0
  ceil: number; // maps to 100
}

export const FITNESS_REFS: Record<string, RefBand> = {
  sprint_30m: { unit: "s", betterDirection: "lower", floor: 5.5, ceil: 3.8 },
  reaction: { unit: "ms", betterDirection: "lower", floor: 400, ceil: 150 },
  grip_strength: { unit: "kg", betterDirection: "higher", floor: 20, ceil: 60 },
  yo_yo: { unit: "level", betterDirection: "higher", floor: 8, ceil: 21 },
  vertical_jump: { unit: "cm", betterDirection: "higher", floor: 20, ceil: 70 },
  plank: { unit: "s", betterDirection: "higher", floor: 30, ceil: 240 },
};

export interface FitnessSummary {
  athlete_id: string;
  tests: Array<{ type: string; value: number; unit: string; score: number; date: string }>;
  fitnessScore: number | null; // mean of component scores, 0..100; null if no tests
}

export class PerformanceLabService {
  constructor(private db: DBPort) {}

  async record(input: { athlete_id: string; type: string; value: number; date?: string }) {
    if (!FITNESS_REFS[input.type]) {
      throw new Error(`Unknown fitness test type: ${input.type}`);
    }
    const row: Omit<FitnessTest, "id"> = {
      athlete_id: input.athlete_id,
      type: input.type,
      value: input.value,
      date: input.date ?? new Date().toISOString(),
    };
    return this.db.insertFitnessTest(row);
  }

  async summary(athleteId: string): Promise<FitnessSummary> {
    const tests = await this.db.getFitnessTests(athleteId);
    // latest per type
    const latest = new Map<string, FitnessTest>();
    for (const t of tests) {
      const prev = latest.get(t.type);
      if (!prev || t.date > prev.date) latest.set(t.type, t);
    }
    const scored = [...latest.values()].map((t) => {
      const ref = FITNESS_REFS[t.type];
      return {
        type: t.type,
        value: t.value,
        unit: ref?.unit ?? "",
        score: ref ? normalize(t.value, ref) : 0,
        date: t.date,
      };
    });
    const fitnessScore =
      scored.length === 0
        ? null
        : Math.round((scored.reduce((s, x) => s + x.score, 0) / scored.length) * 10) / 10;

    return { athlete_id: athleteId, tests: scored, fitnessScore };
  }
}

function normalize(value: number, ref: RefBand): number {
  const { floor, ceil } = ref;
  const pct = ((value - floor) / (ceil - floor)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}
