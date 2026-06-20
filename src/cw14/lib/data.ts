// CW14 · DATA ACCESS LAYER
// Routes to real Supabase when configured, else mock fixtures (offline CI/tests).
// The RLS-safety invariant is preserved in BOTH paths:
//   - scout reads use userClient(jwt) => RLS-filtered (real) / simulated-RLS (mock)
//   - writes use serviceClient()       => bypasses RLS by design
//
// Search uses Postgres FTS on sports_athletes in the real path (R2 deliverable).

import { supabaseConfigured, serviceClient, userClient } from './supabase';
import {
  mockAthletes, mockGrantedAthleteIds, mockWatchlists, mockReports,
  mockTrials, mockRegistrations, mockScholarships,
} from '../mocks/fixtures';
import type {
  Athlete, Watchlist, ScoutReport, Trial, TrialRegistration, Scholarship,
} from './contracts';

// ── shared age helpers (mirror DB sports_is_minor) ──
function ageFromDob(dob?: string | null): number | null {
  if (!dob) return null;
  const d = new Date(dob), now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a;
}
export const isMinor = (dob?: string | null) => { const a = ageFromDob(dob); return a !== null && a < 18; };
export { ageFromDob };

export interface SearchFilters {
  sport?: string; role?: string; state?: string; age?: number; q?: string;
}

// ── SCOUT READS (through RLS) ──
// jwt: the scout's token. Real path: anon client + JWT => Postgres RLS returns
// only rows the scout may see (private/minor without grant are never returned).
export async function searchAthletes(jwt: string | undefined, f: SearchFilters): Promise<Athlete[]> {
  if (supabaseConfigured()) {
    // DEFENSE-IN-DEPTH: scout reads MUST go through the user/anon-scoped client so
    // Postgres RLS gates the rowset (minors non-discoverable). userClient() never
    // uses the service-role key — that's the one client that would bypass RLS and
    // leak minor rows. We do not hand-filter the real path: RLS is the gate, and
    // re-filtering in JS would risk dropping legitimately-granted rows. We DO clamp
    // limits + validate inputs to keep the query well-formed.
    const sb = userClient(jwt);
    let query = sb.from('sports_athletes').select('*'); // RLS already gates the rowset
    if (f.sport) query = query.eq('sport', f.sport);
    if (f.role) query = query.eq('role', f.role);
    if (f.state) query = query.eq('state', f.state);
    if (f.q) query = query.textSearch('fts', f.q); // Postgres FTS column (R2 migration)
    const { data, error } = await query.limit(100);
    if (error) throw error;
    let rows = (data ?? []) as Athlete[];
    if (f.age != null) rows = rows.filter((a) => ageFromDob(a.dob) === f.age);
    return rows;
  }
  // MOCK path simulates exactly what RLS would return to a scout.
  return mockAthletes.filter((a) => {
    const discoverable = a.visibility === 'discoverable' || a.visibility === 'public';
    if (!discoverable) return false;
    if (isMinor(a.dob) && !mockGrantedAthleteIds.has(a.id)) return false;
    if (f.sport && a.sport !== f.sport) return false;
    if (f.role && a.role !== f.role) return false;
    if (f.state && a.state !== f.state) return false;
    if (f.age != null && ageFromDob(a.dob) !== f.age) return false;
    return true;
  });
}

export async function athletesByIds(jwt: string | undefined, ids: string[]): Promise<Athlete[]> {
  if (supabaseConfigured()) {
    const sb = userClient(jwt);
    const { data, error } = await sb.from('sports_athletes').select('*').in('id', ids);
    if (error) throw error;
    return (data ?? []) as Athlete[]; // RLS already dropped disallowed ids
  }
  return mockAthletes.filter((a) => {
    if (!ids.includes(a.id)) return false;
    const discoverable = a.visibility === 'discoverable' || a.visibility === 'public';
    if (!discoverable) return false;
    if (isMinor(a.dob) && !mockGrantedAthleteIds.has(a.id)) return false;
    return true;
  });
}

// ── WRITES (service role; CW14-owned tables) ──
export async function createWatchlist(wl: Watchlist): Promise<Watchlist> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_watchlists').insert(wl).select().single();
    if (error) throw error;
    return data as Watchlist;
  }
  mockWatchlists.push(wl); return wl;
}

export async function listWatchlists(scoutId: string): Promise<Watchlist[]> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient()
      .from('sports_watchlists').select('*').eq('scout_id', scoutId).order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Watchlist[];
  }
  return mockWatchlists.filter((w) => w.scout_id === scoutId);
}

export async function getWatchlist(id: string): Promise<Watchlist | undefined> {
  if (supabaseConfigured()) {
    const { data } = await serviceClient().from('sports_watchlists').select('*').eq('id', id).maybeSingle();
    return (data ?? undefined) as Watchlist | undefined;
  }
  return mockWatchlists.find((w) => w.id === id);
}

export async function updateWatchlist(wl: Watchlist): Promise<Watchlist> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient()
      .from('sports_watchlists').update({ name: wl.name, athlete_ids: wl.athlete_ids }).eq('id', wl.id).select().single();
    if (error) throw error;
    return data as Watchlist;
  }
  return wl; // mock mutated in place by caller
}

export async function listReports(scoutId: string): Promise<ScoutReport[]> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient()
      .from('sports_scout_reports').select('*').eq('scout_id', scoutId).order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as ScoutReport[];
  }
  return mockReports.filter((r) => r.scout_id === scoutId);
}

export async function createReport(r: ScoutReport): Promise<ScoutReport> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_scout_reports').insert(r).select().single();
    if (error) throw error;
    return data as ScoutReport;
  }
  mockReports.push(r); return r;
}

export async function createTrial(t: Trial): Promise<Trial> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_trials').insert(t).select().single();
    if (error) throw error;
    return data as Trial;
  }
  mockTrials.push(t); return t;
}

export async function listTrials(f: { sport?: string; status?: string }): Promise<Trial[]> {
  if (supabaseConfigured()) {
    let q = serviceClient().from('sports_trials').select('*');
    if (f.sport) q = q.eq('sport', f.sport);
    if (f.status) q = q.eq('status', f.status);
    const { data, error } = await q.order('scheduled_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as Trial[];
  }
  return mockTrials.filter((t) => (!f.sport || t.sport === f.sport) && (!f.status || t.status === f.status));
}

export async function listRegistrations(trialId: string): Promise<TrialRegistration[]> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient()
      .from('sports_trial_registrations').select('*').eq('trial_id', trialId);
    if (error) throw error;
    return (data ?? []) as TrialRegistration[];
  }
  return mockRegistrations.filter((r) => r.trial_id === trialId);
}

export async function getTrial(id: string): Promise<Trial | undefined> {
  if (supabaseConfigured()) {
    const { data } = await serviceClient().from('sports_trials').select('*').eq('id', id).maybeSingle();
    return (data ?? undefined) as Trial | undefined;
  }
  return mockTrials.find((t) => t.id === id);
}

export async function createRegistration(reg: TrialRegistration): Promise<TrialRegistration> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_trial_registrations').insert(reg).select().single();
    if (error) throw error;
    return data as TrialRegistration;
  }
  mockRegistrations.push(reg); return reg;
}

export async function getRegistration(id: string): Promise<TrialRegistration | undefined> {
  if (supabaseConfigured()) {
    const { data } = await serviceClient().from('sports_trial_registrations').select('*').eq('id', id).maybeSingle();
    return (data ?? undefined) as TrialRegistration | undefined;
  }
  return mockRegistrations.find((r) => r.id === id);
}

export async function updateRegistration(reg: TrialRegistration): Promise<TrialRegistration> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_trial_registrations')
      .update({ status: reg.status, selection_result: reg.selection_result })
      .eq('id', reg.id).select().single();
    if (error) throw error;
    return data as TrialRegistration;
  }
  return reg; // mock objects are mutated in place by caller
}

export async function listScholarships(f: { sport?: string; age?: number }): Promise<Scholarship[]> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_scholarships').select('*');
    if (error) throw error;
    return filterScholarships((data ?? []) as Scholarship[], f);
  }
  return filterScholarships(mockScholarships, f);
}

function filterScholarships(rows: Scholarship[], f: { sport?: string; age?: number }): Scholarship[] {
  let out = rows;
  if (f.sport) out = out.filter((s) => !s.sport || s.sport === f.sport);
  if (f.age != null) {
    const a = f.age;
    out = out.filter((s) => {
      const e = s.eligibility_json as any;
      if (typeof e?.max_age === 'number') return a <= e.max_age;
      if (Array.isArray(e?.age_range)) return a >= e.age_range[0] && a <= e.age_range[1];
      return true;
    });
  }
  return out;
}

// ── v2.0: recruiting funnel + saved searches + alerts ──
import type { FunnelEntry, SavedSearch, SearchAlert } from './contracts';

const mockFunnel: FunnelEntry[] = [];
const mockSavedSearches: SavedSearch[] = [];
const mockAlerts: SearchAlert[] = [];

export async function createFunnelEntry(e: FunnelEntry): Promise<FunnelEntry> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_funnel').insert(e).select().single();
    if (error) throw error;
    return data as FunnelEntry;
  }
  mockFunnel.push(e); return e;
}
export async function getFunnelEntry(id: string): Promise<FunnelEntry | undefined> {
  if (supabaseConfigured()) {
    const { data } = await serviceClient().from('sports_funnel').select('*').eq('id', id).maybeSingle();
    return (data ?? undefined) as FunnelEntry | undefined;
  }
  return mockFunnel.find((f) => f.id === id);
}
export async function listFunnel(scoutId: string): Promise<FunnelEntry[]> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_funnel').select('*').eq('scout_id', scoutId).order('updated_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as FunnelEntry[];
  }
  return mockFunnel.filter((f) => f.scout_id === scoutId);
}
export async function updateFunnelEntry(e: FunnelEntry): Promise<FunnelEntry> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_funnel')
      .update({ stage: e.stage, parent_consent_at: e.parent_consent_at, trial_id: e.trial_id, offer_id: e.offer_id, notes: e.notes, updated_at: e.updated_at, history: e.history })
      .eq('id', e.id).select().single();
    if (error) throw error;
    return data as FunnelEntry;
  }
  return e;
}

export async function createSavedSearch(s: SavedSearch): Promise<SavedSearch> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_saved_searches').insert(s).select().single();
    if (error) throw error;
    return data as SavedSearch;
  }
  mockSavedSearches.push(s); return s;
}
export async function listSavedSearches(scoutId: string): Promise<SavedSearch[]> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_saved_searches').select('*').eq('scout_id', scoutId);
    if (error) throw error;
    return (data ?? []) as SavedSearch[];
  }
  return mockSavedSearches.filter((s) => s.scout_id === scoutId);
}
export async function getSavedSearch(id: string): Promise<SavedSearch | undefined> {
  if (supabaseConfigured()) {
    const { data } = await serviceClient().from('sports_saved_searches').select('*').eq('id', id).maybeSingle();
    return (data ?? undefined) as SavedSearch | undefined;
  }
  return mockSavedSearches.find((s) => s.id === id);
}
export async function saveAlerts(alerts: SearchAlert[]): Promise<void> {
  if (alerts.length === 0) return;
  if (supabaseConfigured()) {
    const { error } = await serviceClient().from('sports_search_alerts').insert(alerts);
    if (error) throw error;
    return;
  }
  mockAlerts.push(...alerts);
}
export async function listAlerts(scoutId: string): Promise<SearchAlert[]> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_search_alerts').select('*').eq('scout_id', scoutId).order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as SearchAlert[];
  }
  return mockAlerts.filter((a) => a.scout_id === scoutId);
}

// ── v3.0: marketplace opportunities + matches + talent graph ──
import type { Opportunity, OpportunityMatch, GraphNode, GraphEdge } from './contracts';
import { mockOpportunities, mockGraphNodes, mockGraphEdges } from '../mocks/fixtures';

const mockMatches: OpportunityMatch[] = [];

export async function createOpportunity(o: Opportunity): Promise<Opportunity> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_opportunities').insert(o).select().single();
    if (error) throw error;
    return data as Opportunity;
  }
  mockOpportunities.push(o); return o;
}
export async function listOpportunities(f: { type?: string; sport?: string; status?: string }): Promise<Opportunity[]> {
  if (supabaseConfigured()) {
    let q = serviceClient().from('sports_opportunities').select('*');
    if (f.type) q = q.eq('type', f.type);
    if (f.sport) q = q.eq('sport', f.sport);
    if (f.status) q = q.eq('status', f.status);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Opportunity[];
  }
  return mockOpportunities.filter((o) =>
    (!f.type || o.type === f.type) && (!f.sport || o.sport === f.sport) && (!f.status || o.status === f.status));
}
export async function getOpportunity(id: string): Promise<Opportunity | undefined> {
  if (supabaseConfigured()) {
    const { data } = await serviceClient().from('sports_opportunities').select('*').eq('id', id).maybeSingle();
    return (data ?? undefined) as Opportunity | undefined;
  }
  return mockOpportunities.find((o) => o.id === id);
}
export async function saveMatches(matches: OpportunityMatch[]): Promise<void> {
  if (matches.length === 0) return;
  if (supabaseConfigured()) {
    const { error } = await serviceClient().from('sports_opportunity_matches').insert(matches);
    if (error) throw error;
    return;
  }
  mockMatches.push(...matches);
}
export async function listMatchesForAthlete(athleteId: string): Promise<OpportunityMatch[]> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_opportunity_matches').select('*').eq('athlete_id', athleteId).order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as OpportunityMatch[];
  }
  return mockMatches.filter((m) => m.athlete_id === athleteId);
}
export async function updateMatch(m: OpportunityMatch): Promise<OpportunityMatch> {
  if (supabaseConfigured()) {
    const { data, error } = await serviceClient().from('sports_opportunity_matches')
      .update({ consented: m.consented, status: m.status }).eq('id', m.id).select().single();
    if (error) throw error;
    return data as OpportunityMatch;
  }
  return m;
}
export async function getMatch(id: string): Promise<OpportunityMatch | undefined> {
  if (supabaseConfigured()) {
    const { data } = await serviceClient().from('sports_opportunity_matches').select('*').eq('id', id).maybeSingle();
    return (data ?? undefined) as OpportunityMatch | undefined;
  }
  return mockMatches.find((m) => m.id === id);
}

// Talent graph data (real path loads from sports_graph_* tables; mock uses fixtures).
export async function loadGraphData(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  if (supabaseConfigured()) {
    const sb = serviceClient();
    const [{ data: nodes }, { data: edges }] = await Promise.all([
      sb.from('sports_graph_nodes').select('*'),
      sb.from('sports_graph_edges').select('*'),
    ]);
    return { nodes: (nodes ?? []) as GraphNode[], edges: (edges ?? []) as GraphEdge[] };
  }
  return { nodes: mockGraphNodes, edges: mockGraphEdges };
}
