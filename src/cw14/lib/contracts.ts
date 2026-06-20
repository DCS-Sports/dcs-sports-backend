// ─────────────────────────────────────────────────────────────────────────
// DCS SPORTS · CW14 · FROZEN CONTRACT TYPES
// Source of truth: DAY-0 MANAGER REPLY (S1 schema · S2 API · S4 envelope).
// These mirror the sports_* tables and the frozen REST shapes. Do NOT diverge.
// ─────────────────────────────────────────────────────────────────────────

export type Visibility = 'private' | 'academy' | 'discoverable' | 'public';
export type AthleteRole = string; // sport-agnostic: e.g. 'batsman','bowler','all-rounder'
export type StatSource = 'match' | 'manual' | 'vision';

// ── S1: athlete row (RLS-filtered upstream by CW9/CW10; CW14 never hand-filters)
export interface Athlete {
  id: string;
  user_id: string;
  sport: string;
  role: AthleteRole;
  batting_style?: string | null;
  bowling_style?: string | null;
  state?: string | null;
  district?: string | null;
  dob?: string | null;            // ISO date; minor (<18) => non-discoverable unless grant
  verified_status?: string | null;
  academy_id?: string | null;
  visibility: Visibility;
  created_at?: string;
}

// ── S1: talent_index row (CW15 owns compute; CW14 displays estimate-labeled)
export interface TalentIndex {
  athlete_id: string;
  skill: number;
  potential: number;
  consistency: number;
  pressure: number;
  fitness: number;
  coach: number;
  composite: number;
  computed_at: string;
}

// ── S4: estimate envelope — EVERY AI numeric output ships this exact shape
export interface EstimateEnvelope<T = number> {
  value: T;
  confidence: number;             // 0..1
  estimate: true;
  source: 'vision' | 'talent' | 'coach_ai' | 'scout_ai';
  model_version: string | null;
  generated_at: string;           // ISO
  human_reviewed: boolean;
}

// ── CW14: Scout search result (composes Athlete + optional estimate-labeled rating)
export interface ScoutSearchResult {
  athlete: Athlete;
  // talent shown only when present + always estimate-labeled
  talent?: EstimateEnvelope<number>;
}

export interface Watchlist {
  id: string;
  scout_id: string;
  name: string;
  athlete_ids: string[];
  created_at: string;
}

export interface ScoutReport {
  id: string;
  scout_id: string;
  athlete_id: string;
  body: string;
  // AI first-draft assistant output is estimate-labeled + human_reviewed gates publish
  ai_draft?: EstimateEnvelope<string>;
  created_at: string;
}

// ── CW14: Verified Trials (CW14 OWNS the Athlete→Trial→Scout→Selection seam, ruling #11)
// SCHEMA RECONCILED to CW16's canonical sports_trials (uuid id · host_user_id · visibility).
export type TrialStatus = 'open' | 'closed' | 'completed';
export type TrialVisibility = 'private' | 'discoverable' | 'public';
export type RegistrationStatus = 'registered' | 'attended' | 'no_show' | 'shortlisted' | 'selected';

export interface Trial {
  id: string;                     // uuid (CW16 canonical) — was text
  host_user_id: string;           // CW16 canonical — was organizer_user_id
  sport: string;
  title: string;
  venue?: string | null;
  scheduled_at: string;
  status: TrialStatus;
  visibility: TrialVisibility;    // CW16 canonical — new
  created_at: string;
}

export interface TrialRegistration {
  id: string;                     // uuid
  trial_id: string;               // uuid FK → sports_trials(id)
  athlete_id: string;
  status: RegistrationStatus;
  // selection result is high-stakes => consumes CW12 result, requires human action
  selection_result?: {
    selected: boolean;
    note?: string;
    decided_by: string | null;    // human; null until a human acts
    decided_at?: string | null;
  };
  registered_at: string;
}

// ── CW14: Scholarships / Grants (R4) — mapping rows
export interface Scholarship {
  id: string;
  name: string;
  provider: 'KIRTI' | 'Khelo India' | 'SAI' | 'University' | string;
  sport?: string | null;
  eligibility_json: Record<string, unknown>;
  url?: string | null;
}

// ── CW14: Sponsor Connect (R4) — criteria match (estimate-labeled match score)
export interface SponsorMatch {
  sponsor_id: string;
  athlete_id: string;
  match_score: EstimateEnvelope<number>;
}

// ─────────────────────────────────────────────────────────────────────────
// R5/R6 — Legal/Contract OS + Athlete Agent OS. SCAFFOLD ONLY.
// Data models + state machines exist; NOTHING executes, NO money moves.
// Every contract/offer/escrow row carries mode:'test' and stays DARK until
// DK's money-flip AND counsel clear. Minor athletes require parent co-consent
// recorded before any offer can be presented.
// ─────────────────────────────────────────────────────────────────────────

export type ContractKind = 'trial_offer' | 'academy_enrollment' | 'brand_deal' | 'sponsorship' | 'transfer';
export type OfferStatus =
  | 'draft'           // being composed; not visible to athlete
  | 'presented'       // shown to athlete/guardian; awaiting their action
  | 'countered'       // athlete/guardian proposed changes
  | 'accepted'        // both sides agreed — STILL no money/execution (DARK)
  | 'declined'
  | 'withdrawn'
  | 'expired';

// An offer/e-contract. Execution (signature, escrow funding) is DARK.
export interface Offer {
  id: string;
  kind: ContractKind;
  from_user_id: string;          // academy / scout / sponsor
  athlete_id: string;
  terms_json: Record<string, unknown>;   // structured terms; no free-form legal text execution
  value_amount?: number | null;  // informational only — never charged
  currency?: string | null;
  status: OfferStatus;
  requires_parent_consent: boolean;       // true when athlete is a minor
  parent_consent_at?: string | null;      // set only when guardian co-consents
  mode: 'test';                  // FROZEN: always test until DK flip
  created_at: string;
  updated_at: string;
  history: Array<{ at: string; actor: string; action: string; note?: string }>;
}

// Escrow scaffold — DARK. Tracks intent only; no funds held, no payout.
export type EscrowState = 'none' | 'intent_recorded' | 'would_fund' | 'would_release' | 'would_refund';
export interface EscrowRecord {
  id: string;
  offer_id: string;
  state: EscrowState;
  amount?: number | null;
  splits_json?: Record<string, number> | null;  // e.g. {athlete:0.70, academy:0.15, agent:0.10, dcs:0.05}
  mode: 'test';                  // FROZEN
  note: string;                  // always documents that no money moved
}

// ── R6: Talent / Scout / Rankings CALIBRATION HARNESS ──
// Build-gated only. Recompute is real; the VALIDATION verdict is adoption-gated
// (real match data via League OS). Outputs estimate-labeled until validated.
export interface CalibrationInput {
  athlete_id: string;
  sub_scores: { skill: number; potential: number; consistency: number; pressure: number; fitness: number; coach: number };
  sample_size: number;           // # of real matches/trials behind the scores
}
export interface CalibrationResult {
  athlete_id: string;
  composite: EstimateEnvelope<number>;
  // honest data-readiness signal: low sample => low confidence, flagged not-yet-validated
  validated: false;              // FROZEN until adoption produces ground truth
  data_readiness: 'insufficient' | 'emerging' | 'sufficient';
}

// ─────────────────────────────────────────────────────────────────────────
// v2.0 — RECRUITING FUNNEL (Hudl-style) + SAVED-SEARCH ALERTS
// Funnel stages a scout's interest in an athlete through a consent-gated pipeline.
// Contact + offer are gated: a minor cannot be contacted without guardian consent,
// and the funnel reuses the DARK Offer/escrow scaffold for the offer stage.
// ─────────────────────────────────────────────────────────────────────────

export type FunnelStage =
  | 'shortlisted'        // scout flagged interest (no athlete contact yet)
  | 'contact_requested'  // scout asked to contact; consent gate evaluated
  | 'contacted'          // contact allowed (adult, or minor w/ guardian consent)
  | 'trial_invited'      // athlete invited to a trial
  | 'trial_completed'    // trial run + result recorded
  | 'offer_made'         // offer logged (DARK Offer scaffold)
  | 'closed';            // funnel closed (declined/withdrawn/signed-intent)

export interface FunnelEntry {
  id: string;
  scout_id: string;
  athlete_id: string;
  stage: FunnelStage;
  // contact gating: a minor requires guardian consent before 'contacted'
  requires_parent_consent: boolean;
  parent_consent_at?: string | null;
  trial_id?: string | null;          // links the trial stage
  offer_id?: string | null;          // links the DARK Offer scaffold
  notes?: string | null;
  created_at: string;
  updated_at: string;
  history: Array<{ at: string; actor: string; action: string; note?: string }>;
}

// Saved search: persist a scout's criteria; fire an alert when a new matching
// athlete appears (discoverable, RLS-safe — minors never matched without a grant).
export interface SavedSearch {
  id: string;
  scout_id: string;
  name: string;
  criteria_json: { sport?: string; role?: string; state?: string; age?: number; min_rating?: number; q?: string };
  last_run_at?: string | null;
  created_at: string;
}

export interface SearchAlert {
  id: string;
  saved_search_id: string;
  scout_id: string;
  athlete_id: string;        // the newly-matching athlete
  reason: string;            // human-readable why it matched
  created_at: string;
  read: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// v3.0 — OPPORTUNITY MARKETPLACE + DCS TALENT GRAPH
// Marketplace: athletes/scouts/agents/academies/sponsors post openings; the
// engine matches athletes to opportunities they didn't search for, consent-gated.
// Talent Graph: typed relationship graph for discovery (athlete↔coach↔scout…).
// Money DARK · minors never matched/surfaced without a grant · matches estimate-labeled.
// ─────────────────────────────────────────────────────────────────────────

export type OpportunityType = 'trial' | 'scholarship' | 'academy_opening' | 'sponsorship' | 'job';
export type OpportunityStatus = 'open' | 'closed';

export interface Opportunity {
  id: string;
  type: OpportunityType;
  posted_by: string;             // user id of poster (academy/scout/sponsor/agent)
  title: string;
  sport?: string | null;
  criteria_json: {               // who it's for — used by the matcher
    sport?: string; role?: string; state?: string;
    min_age?: number; max_age?: number; min_rating?: number;
  };
  value_amount?: number | null;  // informational only — DARK
  currency?: string | null;
  status: OpportunityStatus;
  created_at: string;
}

// A consented, AI-matched recommendation surfaced TO an athlete (they didn't search).
export interface OpportunityMatch {
  id: string;
  opportunity_id: string;
  athlete_id: string;
  score: EstimateEnvelope<number>;   // match score — estimate-labeled
  reason: string;                    // why it matched (human-readable)
  consented: boolean;                // athlete (or guardian, if minor) accepted surfacing
  status: 'surfaced' | 'accepted' | 'dismissed';
  created_at: string;
}

// ── DCS Talent Graph ──
export type GraphNodeType = 'athlete' | 'coach' | 'academy' | 'league' | 'scout' | 'agent' | 'sponsor';
export type GraphEdgeType =
  | 'coaches' | 'plays_for' | 'member_of' | 'scouted_by' | 'represented_by'
  | 'sponsors' | 'competed_in' | 'verified_by';

export interface GraphNode {
  id: string;            // entity id (athlete_id, user_id, academy_id…)
  type: GraphNodeType;
  label: string;
}
export interface GraphEdge {
  from_id: string;
  to_id: string;
  type: GraphEdgeType;
  since?: string | null;
}
export interface GraphPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
  length: number;        // edge count
}
