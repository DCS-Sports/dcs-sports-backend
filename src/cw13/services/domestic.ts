// CW13 — Domestic/Ranji OS + Selection Intelligence (module 4.9).
// Selection Intelligence emits a composite signal over the FROZEN S4 estimate
// envelope. Advisory only — high-stakes selection goes through CW16's agent
// layer (high_stakes:true) and requires a human action. CW13 computes the
// season/career summary + the estimate-labeled signal; it does not select.
//
// Factors (roadmap R4): form · consistency · pressure · age · venue.

import type { EstimateEnvelope } from '../lib/contracts';
import { getAthlete, getSeasonPerformances, getAllPerformances } from './domestic-repo';

export interface Factors {
  form: number;        // recent run-rate trend, 0..1
  consistency: number; // inverse variance of scores, 0..1
  pressure: number;    // weighted by match pressure_index, 0..1
  age: number;         // youth premium (younger = higher selection upside), 0..1
  venue: number;       // adaptability across venues, 0..1
}

export interface DomesticSeasonSummary {
  athlete_id: string;
  athlete_name: string;
  season: string;
  matches: number;
  runs: number;
  wickets: number;
  high_score: number;
  selection_signal: EstimateEnvelope;
  factors: Factors;
}

export interface CareerSummary {
  athlete_id: string;
  athlete_name: string;
  seasons: { season: string; matches: number; runs: number; wickets: number; high_score: number }[];
  totals: { matches: number; runs: number; wickets: number; high_score: number };
  selection_signal: EstimateEnvelope;
  factors: Factors;
}

const WEIGHTS = { form: 0.3, consistency: 0.2, pressure: 0.2, age: 0.15, venue: 0.15 };

export async function domesticSeason(athleteId: string, season: string): Promise<DomesticSeasonSummary> {
  const ath = await getAthlete(athleteId);
  if (!ath) throw new Error('NOT_FOUND: athlete ' + athleteId);

  const rows = await getSeasonPerformances(athleteId, season);
  const agg = aggregate(rows);
  const factors = computeFactors(rows, ath.dob);
  const { signal } = composeSignal(factors, rows.length);

  return {
    athlete_id: athleteId,
    athlete_name: ath.name,
    season,
    matches: agg.matches,
    runs: agg.runs,
    wickets: agg.wickets,
    high_score: agg.high_score,
    selection_signal: signal,
    factors: roundFactors(factors),
  };
}

export async function career(athleteId: string): Promise<CareerSummary> {
  const ath = await getAthlete(athleteId);
  if (!ath) throw new Error('NOT_FOUND: athlete ' + athleteId);

  const rows = await getAllPerformances(athleteId);
  const bySeason = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = bySeason.get(r.season) ?? [];
    arr.push(r);
    bySeason.set(r.season, arr);
  }
  const seasons = [...bySeason.entries()]
    .map(([season, rs]) => ({ season, ...aggregate(rs) }))
    .sort((a, b) => a.season.localeCompare(b.season));

  const totals = aggregate(rows);
  const factors = computeFactors(rows, ath.dob);
  const { signal } = composeSignal(factors, rows.length);

  return {
    athlete_id: athleteId,
    athlete_name: ath.name,
    seasons,
    totals: { matches: totals.matches, runs: totals.runs, wickets: totals.wickets, high_score: totals.high_score },
    selection_signal: signal,
    factors: roundFactors(factors),
  };
}

function aggregate(rows: { runs: number; wickets: number }[]) {
  return {
    matches: rows.length,
    runs: rows.reduce((s, r) => s + r.runs, 0),
    wickets: rows.reduce((s, r) => s + r.wickets, 0),
    high_score: rows.reduce((m, r) => Math.max(m, r.runs), 0),
  };
}

function computeFactors(
  rows: { runs: number; pressure_index: number; venue: string }[],
  dob?: string
): Factors {
  if (rows.length === 0) return { form: 0, consistency: 0, pressure: 0, age: ageFactor(dob), venue: 0 };
  const runs = rows.map((r) => r.runs);
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;

  const weighted = rows.reduce((acc, r, i) => acc + r.runs * (i + 1), 0);
  const weightSum = rows.reduce((acc, _r, i) => acc + (i + 1), 0);
  const form = clamp01(weighted / weightSum / 50);

  const variance = runs.reduce((a, r) => a + (r - mean) ** 2, 0) / runs.length;
  const std = Math.sqrt(variance);
  const consistency = clamp01(1 - std / (mean + 1));

  const pSum = rows.reduce((a, r) => a + r.pressure_index, 0) || 1;
  const pressure = clamp01(rows.reduce((a, r) => a + (r.runs / 50) * r.pressure_index, 0) / pSum);

  // venue: adaptability — reward scoring spread across distinct venues.
  const venues = new Set(rows.map((r) => r.venue || 'unknown'));
  const venueRuns = new Map<string, number>();
  for (const r of rows) venueRuns.set(r.venue || 'unknown', (venueRuns.get(r.venue || 'unknown') ?? 0) + r.runs);
  const distinct = venues.size;
  const breadth = clamp01((distinct - 1) / 3); // 4+ venues => full breadth
  const minVenueAvg = Math.min(...[...venueRuns.values()]) / 50;
  const venue = clamp01(0.6 * breadth + 0.4 * clamp01(minVenueAvg));

  return { form, consistency, pressure, age: ageFactor(dob), venue };
}

// Youth premium: U19 highest selection upside, tapering to ~0.3 by 30+.
function ageFactor(dob?: string): number {
  if (!dob) return 0.5;
  const age = (Date.now() - new Date(dob).getTime()) / (365.25 * 864e5);
  if (age <= 19) return 1;
  if (age >= 32) return 0.3;
  return clamp01(1 - (age - 19) / (32 - 19) * 0.7);
}

function composeSignal(f: Factors, sample: number): { composite: number; signal: EstimateEnvelope } {
  const composite =
    WEIGHTS.form * f.form +
    WEIGHTS.consistency * f.consistency +
    WEIGHTS.pressure * f.pressure +
    WEIGHTS.age * f.age +
    WEIGHTS.venue * f.venue;
  const confidence = Math.min(0.95, 0.3 + sample * 0.1);
  const signal: EstimateEnvelope = {
    value: round(composite),
    confidence: round(confidence),
    estimate: true,
    source: 'talent',
    model_version: null, // heuristic — no trained model in-session
    generated_at: new Date().toISOString(),
    human_reviewed: false,
  };
  return { composite, signal };
}

function roundFactors(f: Factors): Factors {
  return { form: round(f.form), consistency: round(f.consistency), pressure: round(f.pressure), age: round(f.age), venue: round(f.venue) };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number) => Math.round(n * 1000) / 1000;
