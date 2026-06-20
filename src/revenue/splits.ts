// src/revenue/splits.ts
// Revenue-Sharing engine (4.18). FULL logic, mode ALWAYS 'test'.
// CW16 NEVER moves money. No Razorpay capture, no payout. DK flips later.
import { RevenueEvent, RevenueSource, RevenueSplit } from '../types';

/** Default split: 70 athlete / 15 academy / 10 agent / 5 DCS.
 *  Integer-paise arithmetic with remainder swept to DCS so the four parts
 *  always sum EXACTLY to gross (no rounding leak). */
export interface SplitConfig {
  athlete: number;
  academy: number;
  agent: number;
  dcs: number; // ratios must sum to 1.0
}

export const DEFAULT_SPLIT: SplitConfig = {
  athlete: 0.7,
  academy: 0.15,
  agent: 0.1,
  dcs: 0.05,
};

export function computeSplit(grossPaise: number, cfg: SplitConfig = DEFAULT_SPLIT): RevenueSplit {
  if (!Number.isInteger(grossPaise) || grossPaise < 0) {
    throw new Error(`[revenue] gross must be a non-negative integer (paise); got ${grossPaise}`);
  }
  const ratioSum = cfg.athlete + cfg.academy + cfg.agent + cfg.dcs;
  if (Math.abs(ratioSum - 1) > 1e-9) {
    throw new Error(`[revenue] split ratios must sum to 1.0; got ${ratioSum}`);
  }
  const athlete = Math.floor(grossPaise * cfg.athlete);
  const academy = Math.floor(grossPaise * cfg.academy);
  const agent = Math.floor(grossPaise * cfg.agent);
  // DCS absorbs the floor remainder so the invariant holds exactly.
  const dcs = grossPaise - athlete - academy - agent;
  const split: RevenueSplit = { athlete, academy, agent, dcs };
  assertSplitInvariant(grossPaise, split);
  return split;
}

export function assertSplitInvariant(grossPaise: number, s: RevenueSplit): void {
  const sum = s.athlete + s.academy + s.agent + s.dcs;
  if (sum !== grossPaise) {
    throw new Error(`[revenue] split invariant broken: ${sum} !== gross ${grossPaise}`);
  }
}

/** Build a test-mode RevenueEvent. mode is hard-coded 'test' — there is no
 *  parameter to make it 'live'. Money stays DARK at the type level. */
export function buildRevenueEvent(
  source: RevenueSource,
  athleteId: string | null,
  grossPaise: number,
  cfg: SplitConfig = DEFAULT_SPLIT
): RevenueEvent {
  return {
    source,
    athlete_id: athleteId,
    gross: grossPaise,
    splits_json: computeSplit(grossPaise, cfg),
    mode: 'test',
  };
}
