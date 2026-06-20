import type {
  Athlete, AthleteStats, MatchPerformance, Media,
  ParentLink, TimelineEntry, ParentAlert,
} from '../lib/types';

/**
 * DAY-0 MOCKS — contract-valid JSON only. No DB yet.
 * Two athletes:
 *  - ath_adult: dob 1999, visibility 'discoverable'  (adult, scout-visible per RLS)
 *  - ath_minor: dob 2012, visibility 'discoverable' BUT minor -> CW9/RLS keeps
 *    non-discoverable until a parent grant + DK/counsel flip. CW10 only SETS the
 *    enum; we never gate reads ourselves (Manager ruling, CW10 one-liner).
 */

export const athletes: Record<string, Athlete> = {
  ath_adult: {
    id: 'ath_adult',
    user_id: 'usr_adult',
    sport: 'cricket',
    role: 'all-rounder',
    batting_style: 'right-hand',
    bowling_style: 'right-arm-medium',
    state: 'Haryana',
    district: 'Hisar',
    dob: '1999-04-12',
    verified_status: 'human_verified',
    academy_id: 'acad_1',
    visibility: 'discoverable',
    created_at: '2026-06-19T06:00:00.000Z',
  },
  ath_minor: {
    id: 'ath_minor',
    user_id: 'usr_minor',
    sport: 'cricket',
    role: 'batsman',
    batting_style: 'left-hand',
    bowling_style: null,
    state: 'Haryana',
    district: 'Hisar',
    dob: '2012-09-01',
    verified_status: 'pending',
    academy_id: 'acad_1',
    visibility: 'discoverable',
    created_at: '2026-06-19T06:05:00.000Z',
  },
};

export const stats: Record<string, AthleteStats[]> = {
  ath_adult: [{
    id: 'stat_1', athlete_id: 'ath_adult', season: '2025-26',
    matches: 14, runs: 612, wickets: 11, avg: 47.1, strike_rate: 138.4,
    batting_rating: 78, bowling_rating: 61, fielding_rating: 70, source: 'match',
  }],
  ath_minor: [{
    id: 'stat_2', athlete_id: 'ath_minor', season: '2025-26',
    matches: 6, runs: 188, wickets: 0, avg: 31.3, strike_rate: 104.0,
    batting_rating: 64, bowling_rating: 0, fielding_rating: 58, source: 'match',
  }],
};

export const performances: Record<string, MatchPerformance[]> = {
  ath_adult: [{
    id: 'mp_1', match_id: 'mat_1', athlete_id: 'ath_adult',
    runs: 74, balls: 49, fours: 6, sixes: 3, overs: 4, wickets: 2,
    runs_conceded: 31, catches: 1, source: 'match',
  }],
  ath_minor: [{
    id: 'mp_2', match_id: 'mat_1', athlete_id: 'ath_minor',
    runs: 41, balls: 38, fours: 4, sixes: 0, overs: 0, wickets: 0,
    runs_conceded: 0, catches: 0, source: 'match',
  }],
};

export const media: Record<string, Media[]> = {
  ath_adult: [{
    id: 'med_1', athlete_id: 'ath_adult', type: 'video',
    url: 'https://r2.dcs-sports.example/ath_adult/highlight_1.mp4',
    created_at: '2026-06-18T12:00:00.000Z',
  }],
  ath_minor: [],
};

export const parentLinks: ParentLink[] = [{
  parent_user_id: 'usr_parent',
  athlete_id: 'ath_minor',
  relation: 'mother',
  consent: true,
  consented_at: '2026-06-19T07:00:00.000Z',
}];

export const timeline: Record<string, TimelineEntry[]> = {
  ath_adult: [
    { id: 'tl_1', athlete_id: 'ath_adult', kind: 'match', ref_id: 'mat_1', label: 'Scored 74 (49) vs Rohtak XI', ts: '2026-06-18T16:00:00.000Z' },
    { id: 'tl_2', athlete_id: 'ath_adult', kind: 'verification', ref_id: 'ver_1', label: 'Athlete verified', ts: '2026-06-17T09:00:00.000Z' },
  ],
  ath_minor: [
    { id: 'tl_3', athlete_id: 'ath_minor', kind: 'match', ref_id: 'mat_1', label: 'Scored 41 (38) vs Rohtak XI', ts: '2026-06-18T16:00:00.000Z' },
  ],
};

export const alerts: Record<string, ParentAlert[]> = {
  // keyed by parent user_id for Parent OS
  usr_parent: [
    { id: 'al_1', athlete_id: 'ath_minor', type: 'upcoming_match', message: 'Match vs Sirsa XI on 21 Jun', ts: '2026-06-19T08:00:00.000Z', read: false },
  ],
};

export const childrenByParent: Record<string, string[]> = {
  usr_parent: ['ath_minor'],
};

/* ---- v2.0 mock collections ---- */
import type { VisionJob, Highlight } from '../lib/types';

export const visionJobs: VisionJob[] = [];

// A processed drill estimate for ath_adult so the acceptance demo shows a real
// (placeholder, estimate-labeled) talent number. model_version null => model_dark.
export const talentIndex: { athlete_id: string; skill: string; composite: number; computed_at: string; model_version: string | null; confidence: number | null }[] = [
  { athlete_id: 'ath_adult', skill: 'composite', composite: 72, computed_at: '2026-06-19T10:00:00.000Z', model_version: null, confidence: 0.61 },
  { athlete_id: 'ath_adult', skill: 'speed', composite: 68, computed_at: '2026-06-19T10:00:00.000Z', model_version: null, confidence: 0.6 },
  { athlete_id: 'ath_adult', skill: 'agility', composite: 74, computed_at: '2026-06-19T10:00:00.000Z', model_version: null, confidence: 0.58 },
  { athlete_id: 'ath_adult', skill: 'technique', composite: 70, computed_at: '2026-06-19T10:00:00.000Z', model_version: null, confidence: 0.55 },
];

export const highlights: Highlight[] = [
  { id: 'hl_1', athlete_id: 'ath_adult', job_id: 'vj_seed', title: 'Cover drive — drill', clip_url: 'https://r2.dcs-sports.example/ath_adult/drill_hl.mp4', thumb_url: null, created_at: '2026-06-19T10:05:00.000Z' },
];

/* ---- v3.0 mock collections ---- */
import type { AgentPing, SelectionRecord } from '../lib/types';

export const agentPings: AgentPing[] = [
  { id: 'ping_1', athlete_id: 'ath_adult', agent: 'athlete_agent', title: 'Trial opportunity matches your profile',
    body: 'A State U23 trial is open in Haryana next month. Based on your recent form, consider registering. (You decide — this is a suggestion.)',
    high_stakes: false, status: 'pending', created_at: '2026-06-19T09:00:00.000Z' },
];

export const selectionRecords: SelectionRecord[] = [
  { id: 'sel_1', athlete_id: 'ath_adult', title: 'State U19 squad 2025', level: 'state', date: '2025-08-12T00:00:00.000Z',
    verified_by: 'usr_verifier', sig: 'ed25519:9f2c...a71b', verify_url: 'https://verify.dcsai.ai/sel_1' },
];
