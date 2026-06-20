// CW14 · MOCK FIXTURES (Day-0). Contract-valid JSON; swap to Supabase at R2.
// Includes a minor athlete to demonstrate the SAFE-by-default RLS posture:
// minors are NON-discoverable until a data_access_grant exists (ruling #3).

import type { Athlete, Trial, TrialRegistration, Watchlist, ScoutReport, Scholarship } from '../lib/contracts';

const yearsAgo = (n: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
};

export const mockAthletes: Athlete[] = [
  {
    id: 'ath_001', user_id: 'usr_001', sport: 'cricket', role: 'batsman',
    batting_style: 'right-hand', bowling_style: null, state: 'Haryana', district: 'Hisar',
    dob: yearsAgo(22), verified_status: 'human_verified', academy_id: 'acad_01',
    visibility: 'discoverable', created_at: new Date().toISOString(),
  },
  {
    id: 'ath_002', user_id: 'usr_002', sport: 'cricket', role: 'bowler',
    batting_style: 'right-hand', bowling_style: 'right-arm-fast', state: 'Punjab', district: 'Mohali',
    dob: yearsAgo(24), verified_status: 'human_verified', academy_id: 'acad_02',
    visibility: 'public', created_at: new Date().toISOString(),
  },
  {
    // MINOR — discoverable visibility set, BUT <18 => RLS blocks scout reads
    // until a sports_data_access_grants row exists AND DK/counsel flip is clear.
    id: 'ath_003', user_id: 'usr_003', sport: 'cricket', role: 'all-rounder',
    batting_style: 'left-hand', bowling_style: 'slow-left-arm', state: 'Haryana', district: 'Karnal',
    dob: yearsAgo(15), verified_status: 'human_verified', academy_id: 'acad_01',
    visibility: 'discoverable', created_at: new Date().toISOString(),
  },
];

// Grants present for these (athlete_id). ath_003 has NONE => stays hidden from scouts.
export const mockGrantedAthleteIds = new Set<string>([]); // empty: no minor grant yet (DARK)

export const mockTrials: Trial[] = [
  {
    id: 'f2b5a551-9e81-45e2-861e-47ea6bbf3900', host_user_id: 'usr_org_1', sport: 'cricket',
    title: 'North Zone U-23 Open Trial', venue: 'Hisar', scheduled_at: new Date(Date.now() + 6048e5).toISOString(),
    status: 'open', visibility: 'discoverable', created_at: new Date().toISOString(),
  },
];

export const mockRegistrations: TrialRegistration[] = [
  {
    id: '2d8f804f-5aa3-40b4-bca8-a0cd9a67afe6', trial_id: 'f2b5a551-9e81-45e2-861e-47ea6bbf3900', athlete_id: 'ath_001',
    status: 'registered', registered_at: new Date().toISOString(),
  },
  {
    id: 'c77b88a3-101b-499e-b0f7-21587a75664a', trial_id: 'f2b5a551-9e81-45e2-861e-47ea6bbf3900', athlete_id: 'ath_002',
    status: 'selected',
    selection_result: { selected: true, note: 'Top pace', decided_by: 'usr_org_1', decided_at: new Date().toISOString() },
    registered_at: new Date().toISOString(),
  },
];

export const mockWatchlists: Watchlist[] = [
  { id: 'wl_001', scout_id: 'usr_scout_1', name: 'Fast bowlers North', athlete_ids: ['ath_002'], created_at: new Date().toISOString() },
];

export const mockReports: ScoutReport[] = [];

export const mockScholarships: Scholarship[] = [
  { id: 'sch_001', name: 'Khelo India Athlete Scheme', provider: 'Khelo India', sport: 'cricket', eligibility_json: { max_age: 23, level: 'state+' }, url: 'https://kheloindia.gov.in' },
  { id: 'sch_002', name: 'KIRTI Talent Identification', provider: 'KIRTI', sport: null, eligibility_json: { age_range: [9, 18] }, url: null },
  { id: 'sch_003', name: 'SAI National Centre of Excellence', provider: 'SAI', sport: null, eligibility_json: { age_range: [12, 21], level: 'national-potential' }, url: 'https://sportsauthorityofindia.gov.in' },
  { id: 'sch_004', name: 'University Sports Quota (UG Admission)', provider: 'University', sport: null, eligibility_json: { age_range: [16, 25], proof: 'state-representation' }, url: null },
  { id: 'sch_005', name: 'Khelo India Rising Talent (U-17)', provider: 'Khelo India', sport: 'cricket', eligibility_json: { max_age: 17 }, url: 'https://kheloindia.gov.in' },
];

// ── v3.0 marketplace + talent graph fixtures ──
import type { Opportunity, GraphNode, GraphEdge } from '../lib/contracts';

export const mockOpportunities: Opportunity[] = [
  {
    id: 'f1a00000-0000-4000-8000-0000000000o1', type: 'trial', posted_by: 'usr_scout_1',
    title: 'Haryana State U-23 Selection Trial', sport: 'cricket',
    criteria_json: { sport: 'cricket', state: 'Haryana', max_age: 23 },
    value_amount: null, currency: null, status: 'open', created_at: new Date().toISOString(),
  },
  {
    id: 'f1a00000-0000-4000-8000-0000000000o2', type: 'scholarship', posted_by: 'usr_acad_1',
    title: 'Fast-Bowling Academy Scholarship', sport: 'cricket',
    criteria_json: { sport: 'cricket', role: 'bowler' },
    value_amount: null, currency: null, status: 'open', created_at: new Date().toISOString(),
  },
];

// Graph: ath_001 ↔ academy acad_01 ↔ coach usr_coach_1; scout usr_scout_1 ↔ coach usr_coach_1.
// So a path exists scout → coach → academy → ath_001.
export const mockGraphNodes: GraphNode[] = [
  { id: 'ath_001', type: 'athlete', label: 'Athlete 001' },
  { id: 'ath_002', type: 'athlete', label: 'Athlete 002' },
  { id: 'ath_003', type: 'athlete', label: 'Athlete 003 (minor)' },
  { id: 'acad_01', type: 'academy', label: 'Hisar Cricket Academy' },
  { id: 'usr_coach_1', type: 'coach', label: 'Coach A' },
  { id: 'usr_scout_1', type: 'scout', label: 'Scout A' },
];
export const mockGraphEdges: GraphEdge[] = [
  { from_id: 'ath_001', to_id: 'acad_01', type: 'member_of', since: '2025-01-01' },
  { from_id: 'ath_003', to_id: 'acad_01', type: 'member_of', since: '2025-06-01' },
  { from_id: 'usr_coach_1', to_id: 'acad_01', type: 'coaches', since: '2024-01-01' },
  { from_id: 'usr_scout_1', to_id: 'usr_coach_1', type: 'scouted_by', since: '2025-03-01' },
];
