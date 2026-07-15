import { supabaseEnabled, serviceClient, rlsClient } from '../lib/supabase';
import type {
  Athlete, AthleteStats, MatchPerformance, Media, TimelineEntry,
  Visibility, ChildSummary, ParentAlert, MediaType,
} from '../lib/types';
import * as mock from '../mocks/fixtures';

/**
 * Data access for the CW10 lane. Reads run under the caller's RLS context
 * (accessToken) so the DB enforces visibility/consent/minor-gating — we never
 * hand-filter. Writes use the service role. If Supabase env is absent, we serve
 * the Day-0 mocks so the repo stays npm-ci-runnable and green without secrets.
 *
 * Tables (live S1): sports_athletes, sports_athlete_stats,
 * sports_match_performances, sports_media, sports_parent_links.
 */

function reader(accessToken: string | null) {
  // With a real token, read under RLS. Without one, fall back to service role
  // ONLY when Supabase is enabled (dev convenience); production always supplies
  // a caller token from CW9 auth.
  if (accessToken) return rlsClient(accessToken);
  return serviceClient();
}

export async function getAthlete(id: string, accessToken: string | null): Promise<Athlete | null> {
  if (!supabaseEnabled) return mock.athletes[id] ?? null;
  const { data, error } = await reader(accessToken)
    .from('sports_athletes')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as Athlete) ?? null;
}

export async function getStats(athleteId: string, accessToken: string | null): Promise<AthleteStats[]> {
  if (!supabaseEnabled) return mock.stats[athleteId] ?? [];
  const { data, error } = await reader(accessToken)
    .from('sports_athlete_stats')
    .select('*')
    .eq('athlete_id', athleteId);
  if (error) throw error;
  return (data as AthleteStats[]) ?? [];
}

export async function getPerformances(athleteId: string, accessToken: string | null): Promise<MatchPerformance[]> {
  if (!supabaseEnabled) return mock.performances[athleteId] ?? [];
  const { data, error } = await reader(accessToken)
    .from('sports_match_performances')
    .select('*')
    .eq('athlete_id', athleteId);
  if (error) throw error;
  return (data as MatchPerformance[]) ?? [];
}

export async function getMedia(athleteId: string, accessToken: string | null): Promise<Media[]> {
  if (!supabaseEnabled) return mock.media[athleteId] ?? [];
  const { data, error } = await reader(accessToken)
    .from('sports_media')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as Media[]) ?? [];
}

/** WRITE — service role (bypasses RLS). visibility enum only; RLS reacts to it. */
export async function setVisibility(id: string, visibility: Visibility): Promise<boolean> {
  if (!supabaseEnabled) {
    if (!mock.athletes[id]) return false;
    mock.athletes[id].visibility = visibility;
    return true;
  }
  const { error, count } = await serviceClient()
    .from('sports_athletes')
    .update({ visibility }, { count: 'exact' })
    .eq('id', id);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** WRITE — service role. Records a media row (URL already in R2 via CW16 pipeline). */
export async function addMedia(athleteId: string, type: MediaType, url: string): Promise<Media | null> {
  if (!supabaseEnabled) {
    if (!mock.athletes[athleteId]) return null;
    const row: Media = { id: `med_${Date.now()}`, athlete_id: athleteId, type, url, created_at: new Date().toISOString() };
    (mock.media[athleteId] ??= []).push(row);
    return row;
  }
  const { data, error } = await serviceClient()
    .from('sports_media')
    .insert({ athlete_id: athleteId, type, url })
    .select('*')
    .single();
  if (error) throw error;
  return data as Media;
}

/**
 * Timeline: CW10 composes from matches + media + verifications (Q3 still open
 * with Manager — flagged). Until a shared sports_timeline table is confirmed,
 * we derive. Mock path returns the fixture timeline.
 */
export async function getTimeline(athleteId: string, accessToken: string | null): Promise<TimelineEntry[]> {
  if (!supabaseEnabled) return mock.timeline[athleteId] ?? [];
  const client = reader(accessToken);
  const [{ data: perfs }, { data: media }] = await Promise.all([
    client.from('sports_match_performances').select('id, match_id, runs, balls, athlete_id').eq('athlete_id', athleteId),
    client.from('sports_media').select('id, type, created_at, athlete_id').eq('athlete_id', athleteId),
  ]);
  const entries: TimelineEntry[] = [];
  for (const p of (perfs ?? []) as Array<{ id: string; match_id: string; runs: number; balls: number }>) {
    entries.push({ id: `tl_m_${p.id}`, athlete_id: athleteId, kind: 'match', ref_id: p.match_id, label: `Scored ${p.runs} (${p.balls})`, ts: new Date().toISOString() });
  }
  for (const m of (media ?? []) as Array<{ id: string; type: string; created_at: string }>) {
    entries.push({ id: `tl_med_${m.id}`, athlete_id: athleteId, kind: 'media', ref_id: m.id, label: `Added ${m.type}`, ts: m.created_at });
  }
  return entries;
}

/** Parent OS — children via sports_parent_links (consent=true), RLS-gated. */
export async function getChildren(parentUserId: string, accessToken: string | null): Promise<ChildSummary[]> {
  if (!supabaseEnabled) {
    const links = mock.parentLinks.filter((l) => l.parent_user_id === parentUserId && l.consent);
    const ids = links.length ? links.map((l) => l.athlete_id) : (mock.childrenByParent[parentUserId] ?? []);
    return ids.map((cid) => {
      const a = mock.athletes[cid];
      if (!a) return null;
      return { athlete_id: a.id, name_ref: a.user_id, sport: a.sport, role: a.role, recent_matches: (mock.performances[a.id] ?? []).length, visibility: a.visibility };
    }).filter(Boolean) as ChildSummary[];
  }
  const client = reader(accessToken);
  const { data: links, error } = await client
    .from('sports_parent_links')
    .select('athlete_id, consent')
    .eq('parent_user_id', parentUserId)
    .eq('consent', true);
  if (error) throw error;
  const ids = (links ?? []).map((l: { athlete_id: string }) => l.athlete_id);
  if (ids.length === 0) return [];
  const { data: aths, error: e2 } = await client
    .from('sports_athletes')
    .select('id, user_id, sport, role, visibility')
    .in('id', ids);
  if (e2) throw e2;
  return ((aths ?? []) as Array<Pick<Athlete, 'id' | 'user_id' | 'sport' | 'role' | 'visibility'>>).map((a) => ({
    athlete_id: a.id, name_ref: a.user_id, sport: a.sport, role: a.role, recent_matches: 0, visibility: a.visibility,
  }));
}

/** Parent alerts — alert ENGINE is CW16/R2; CW10 reads the shape. Mock for now. */
export async function getAlerts(parentUserId: string): Promise<ParentAlert[]> {
  if (!supabaseEnabled) return mock.alerts[parentUserId] ?? [];
  // Real alert rows are written by CW16's engine (R2). Until that table lands in
  // this lane's scope, return empty rather than fabricate.
  return [];
}

/* ---- MAXIMUM BUILD additions: passport write + Parent OS depth ---- */
import type {
  AthleteUpsert, AttendanceRow, AssessmentRow, ProgressPoint, ChildReport, CoachNote,
} from '../lib/types';

/** The email claim carried by every Supabase access token. Decoding it is more reliable than an
 *  admin API round-trip — the user literally just authenticated with this token. */
export function emailFromJwt(token: string | null | undefined): string | null {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return (claims.email as string) || null;
  } catch { return null; }
}

/** CREATE athlete (service role). Returns the new row.
 *  emailHint: the caller's email (from their JWT) — sports_users.email is NOT NULL on the deployed
 *  schema, so we must supply it when first creating the parent user row. */
export async function createAthlete(input: AthleteUpsert, emailHint?: string | null): Promise<Athlete | null> {
  if (!supabaseEnabled) {
    const id = `ath_${Date.now()}`;
    const row: Athlete = {
      id,
      user_id: input.user_id ?? `usr_${id}`,
      sport: input.sport ?? 'cricket',
      role: input.role ?? null,
      batting_style: input.batting_style ?? null,
      bowling_style: input.bowling_style ?? null,
      state: input.state ?? null,
      district: input.district ?? null,
      dob: input.dob ?? null,
      verified_status: 'pending',
      academy_id: input.academy_id ?? null,
      visibility: input.visibility ?? 'private',
      created_at: new Date().toISOString(),
    };
    mock.athletes[id] = row;
    return row;
  }
  /* 🔴 ENSURE THE PARENT sports_users ROW EXISTS FIRST.   15 Jul 2026
   *
   * sports_athletes.user_id FKs to sports_users(id). Nothing ever created that row: the code note
   * two lines below getOrCreateMyPassport says "sports_users via CW9", and CW9 never wired it. So
   * every first-time athlete insert failed with:
   *     insert or update on table "sports_athletes" violates foreign key constraint
   *     "sports_athletes_user_id_fkey"
   * which is exactly the error a signed-in user saw on first passport load. The athlete id and
   * user_id are both the Supabase auth uid, so we upsert that id into sports_users first. Service
   * role (the row does not exist yet, so RLS could not permit the caller to create it), idempotent,
   * and every non-id column is nullable, so { id } is a complete, valid row. */
  if (input.user_id) {
    /* The DEPLOYED sports_users has email NOT NULL (the hand-run schema differs from the repo
       migration, where email was nullable). Fetch it from the auth user via the service-role admin
       API — a real Google / magic-link user always has one — and include it. */
    let email: string | null = emailHint ?? null;
    if (!email) {
      try {
        const { data: au } = await serviceClient().auth.admin.getUserById(input.user_id);
        email = au?.user?.email ?? null;
      } catch { /* best effort */ }
    }
    const { error: uErr } = await serviceClient()
      .from('sports_users')
      .upsert({ id: input.user_id, email }, { onConflict: 'id', ignoreDuplicates: true });
    if (uErr) throw uErr;
  }

  const { data, error } = await serviceClient()
    .from('sports_athletes')
    .insert({ ...input, sport: input.sport ?? 'cricket', visibility: input.visibility ?? 'private' })
    .select('*')
    .single();
  if (error) throw error;
  return data as Athlete;
}

/** UPDATE athlete profile fields (service role). visibility has its own setter. */
export async function updateAthlete(id: string, patch: AthleteUpsert): Promise<Athlete | null> {
  const { visibility: _v, ...fields } = patch; // visibility goes through setVisibility
  if (!supabaseEnabled) {
    const a = mock.athletes[id];
    if (!a) return null;
    Object.assign(a, fields);
    return a;
  }
  const { data, error } = await serviceClient()
    .from('sports_athletes')
    .update(fields)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return (data as Athlete) ?? null;
}

/** Progress series — composed from match performances (RLS-scoped read). */
export async function getProgress(athleteId: string, accessToken: string | null): Promise<ProgressPoint[]> {
  const perfs = await getPerformances(athleteId, accessToken);
  return perfs.map((p) => ({
    ts: '',
    runs: p.runs,
    balls: p.balls,
    strike_rate: p.balls ? Math.round((p.runs / p.balls) * 1000) / 10 : 0,
    wickets: p.wickets,
  }));
}

/** Attendance (RLS-scoped read; written by CW11). */
export async function getAttendance(athleteId: string, accessToken: string | null): Promise<AttendanceRow[]> {
  if (!supabaseEnabled) return [];
  const { data, error } = await reader(accessToken)
    .from('sports_attendance')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false });
  if (error) throw error;
  return (data as AttendanceRow[]) ?? [];
}

/** Assessments -> coach notes (RLS-scoped read; written by CW11 Coach OS). */
export async function getCoachNotes(athleteId: string, accessToken: string | null): Promise<CoachNote[]> {
  if (!supabaseEnabled) return [];
  const { data, error } = await reader(accessToken)
    .from('sports_assessments')
    .select('id, date, scores_json')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false });
  if (error) throw error;
  return ((data as AssessmentRow[]) ?? []).map((a) => {
    const keys = Object.keys(a.scores_json ?? {});
    const summary = keys.length
      ? keys.map((k) => `${k}: ${a.scores_json[k]}`).join(' · ')
      : 'Assessment recorded';
    return { id: a.id, date: a.date, summary };
  });
}

/** Composed child report for Parent OS (RLS-scoped). Honest empties, no fabrication. */
export async function getChildReport(athleteId: string, accessToken: string | null): Promise<ChildReport | null> {
  const athlete = await getAthlete(athleteId, accessToken);
  if (!athlete) return null;
  const [perfs, attendance, coachNotes] = await Promise.all([
    getProgress(athleteId, accessToken),
    getAttendance(athleteId, accessToken),
    getCoachNotes(athleteId, accessToken),
  ]);
  const attendance_rate = attendance.length
    ? Math.round((attendance.filter((r) => r.present).length / attendance.length) * 100) / 100
    : null;
  return {
    athlete_id: athleteId,
    name_ref: athlete.user_id,
    attendance_rate,
    matches_played: perfs.length,
    recent_form: perfs.slice(0, 10),
    coach_notes: coachNotes.slice(0, 10),
  };
}

/* ---- GO-LIVE additions: consent controls + weekly summary ---- */
import type { ChildReport as _CR } from '../lib/types';

export interface ConsentState {
  athlete_id: string;
  parent_user_id: string;
  consent: boolean;
  consented_at: string | null;
  discoverable_grant: boolean; // a data_access_grant exists allowing discoverable
}

/** Read a parent↔child consent state (Parent OS consent controls surface). */
export async function getConsent(parentUserId: string, athleteId: string, accessToken: string | null): Promise<ConsentState | null> {
  if (!supabaseEnabled) {
    const link = mock.parentLinks.find((l) => l.parent_user_id === parentUserId && l.athlete_id === athleteId);
    if (!link) return null;
    return { athlete_id: athleteId, parent_user_id: parentUserId, consent: link.consent, consented_at: link.consented_at ?? null, discoverable_grant: !!link.consent };
  }
  const client = reader(accessToken);
  const { data, error } = await client
    .from('sports_parent_links')
    .select('consent, consented_at')
    .eq('parent_user_id', parentUserId)
    .eq('athlete_id', athleteId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: grant } = await client
    .from('sports_data_access_grants')
    .select('id, revoked_at')
    .eq('athlete_id', athleteId)
    .is('revoked_at', null)
    .maybeSingle();
  return {
    athlete_id: athleteId, parent_user_id: parentUserId,
    consent: (data as { consent: boolean }).consent,
    consented_at: (data as { consented_at: string | null }).consented_at,
    discoverable_grant: !!grant,
  };
}

/**
 * Parent sets consent for a child (grant or revoke). This toggles the
 * sports_parent_links.consent and, on grant, ensures a data_access_grant exists;
 * on revoke, marks it revoked. Minor-discoverable still needs DK/counsel clear at
 * RLS — this only records the PARENT's half of co-consent.
 */
export async function setConsent(parentUserId: string, athleteId: string, consent: boolean): Promise<ConsentState> {
  if (!supabaseEnabled) {
    let link = mock.parentLinks.find((l) => l.parent_user_id === parentUserId && l.athlete_id === athleteId);
    if (!link) { link = { parent_user_id: parentUserId, athlete_id: athleteId, relation: 'parent', consent, consented_at: consent ? new Date().toISOString() : null }; mock.parentLinks.push(link); }
    else { link.consent = consent; link.consented_at = consent ? new Date().toISOString() : null; }
    return { athlete_id: athleteId, parent_user_id: parentUserId, consent, consented_at: link.consented_at, discoverable_grant: consent };
  }
  const svc = serviceClient();
  const { error } = await svc
    .from('sports_parent_links')
    .update({ consent, consented_at: consent ? new Date().toISOString() : null })
    .eq('parent_user_id', parentUserId)
    .eq('athlete_id', athleteId);
  if (error) throw error;
  if (consent) {
    await svc.from('sports_data_access_grants').insert({ athlete_id: athleteId, grantee_id: parentUserId, scope: 'parent_consent', granted_at: new Date().toISOString() });
  } else {
    await svc.from('sports_data_access_grants').update({ revoked_at: new Date().toISOString() }).eq('athlete_id', athleteId).eq('grantee_id', parentUserId).is('revoked_at', null);
  }
  return { athlete_id: athleteId, parent_user_id: parentUserId, consent, consented_at: consent ? new Date().toISOString() : null, discoverable_grant: consent };
}

export interface WeeklySummary {
  athlete_id: string;
  name_ref: string;
  week_of: string;
  matches_this_week: number;
  runs_this_week: number;
  wickets_this_week: number;
  attendance_marked: number;
  attendance_present: number;
  new_coach_notes: number;
  headline: string;
}

/** Composed weekly summary for Parent OS (last 7 days). Honest empties. */
export async function getWeeklySummary(athleteId: string, accessToken: string | null): Promise<WeeklySummary | null> {
  const report = await getChildReport(athleteId, accessToken);
  if (!report) return null;
  // recent_form has no timestamps in the mock; treat the latest entries as "this week".
  const recent = report.recent_form.slice(0, 5);
  const runs = recent.reduce((s, p) => s + (p.runs || 0), 0);
  const wkts = recent.reduce((s, p) => s + (p.wickets || 0), 0);
  const att = report.attendance_rate;
  const headline = recent.length === 0
    ? 'No matches logged this week.'
    : `${recent.length} match${recent.length === 1 ? '' : 'es'}, ${runs} run${runs === 1 ? '' : 's'}${wkts ? `, ${wkts} wicket${wkts === 1 ? '' : 's'}` : ''}.`;
  return {
    athlete_id: athleteId,
    name_ref: report.name_ref,
    week_of: new Date().toISOString().slice(0, 10),
    matches_this_week: recent.length,
    runs_this_week: runs,
    wickets_this_week: wkts,
    attendance_marked: att == null ? 0 : 1,
    attendance_present: att == null ? 0 : Math.round(att * 100),
    new_coach_notes: report.coach_notes.length,
    headline,
  };
}

/* ---- v1.0: first-login onboarding (get-or-create my passport) ---- */

export interface MyPassport {
  athlete: Athlete;
  created: boolean;          // true if we just created it (drives onboarding)
  onboarding_needed: boolean; // true until name+sport+role are set
}

function needsOnboarding(a: Athlete): boolean {
  // Onboarding is complete once the athlete has a real role set (name lives on
  // sports_users via CW9; sport defaults to cricket). Position/role is the signal.
  return !a.role;
}

/**
 * Get-or-create the passport owned by the authenticated user. Used on first login:
 * if the user has no athlete row yet, create a private/pending one and flag that
 * onboarding is needed. RLS-scoped lookup; service-role create.
 */
export async function getOrCreateMyPassport(userId: string, accessToken: string | null): Promise<MyPassport> {
  if (!supabaseEnabled) {
    let a = Object.values(mock.athletes).find((x) => x.user_id === userId);
    if (a) return { athlete: a, created: false, onboarding_needed: needsOnboarding(a) };
    a = (await createAthlete({ user_id: userId, sport: 'cricket', visibility: 'private' }))!;
    return { athlete: a, created: true, onboarding_needed: true };
  }
  // RLS-scoped read: the user can always read their own row.
  const { data, error } = await reader(accessToken)
    .from('sports_athletes')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (data) {
    const a = data as Athlete;
    return { athlete: a, created: false, onboarding_needed: needsOnboarding(a) };
  }
  const created = await createAthlete({ user_id: userId, sport: 'cricket', visibility: 'private' }, emailFromJwt(accessToken));
  if (!created) throw new Error('passport_create_failed');
  return { athlete: created, created: true, onboarding_needed: true };
}

/** Complete onboarding: set the initial sport/role/styles in one call. */
export interface OnboardingInput {
  role?: string | null;
  sport?: string;
  batting_style?: string | null;
  bowling_style?: string | null;
  state?: string | null;
  district?: string | null;
  dob?: string | null;
}
export async function completeOnboarding(athleteId: string, input: OnboardingInput): Promise<Athlete | null> {
  return updateAthlete(athleteId, {
    role: input.role ?? null,
    sport: input.sport ?? 'cricket',
    batting_style: input.batting_style ?? null,
    bowling_style: input.bowling_style ?? null,
    state: input.state ?? null,
    district: input.district ?? null,
    dob: input.dob ?? null,
  });
}

/* ---- v2.0: video highlights · aiScout drill · recruiting profile ---- */
import type {
  VisionJob, TalentEstimate, Highlight, RecruitingProfile, Estimate,
} from '../lib/types';

const SHARE_BASE = process.env.PUBLIC_SHARE_BASE || 'https://sports.dcsai.ai/p';

/** Submit a drill/match clip → creates a vision job for CW15's worker (service role). */
export async function submitVisionJob(athleteId: string, kind: 'drill' | 'match_clip', videoUrl: string): Promise<VisionJob> {
  if (!supabaseEnabled) {
    const job: VisionJob = { id: `vj_${Date.now()}`, athlete_id: athleteId, kind, video_url: videoUrl, status: 'queued', version: null, created_at: new Date().toISOString() };
    mock.visionJobs.push(job);
    return job;
  }
  const { data, error } = await serviceClient()
    .from('sports_vision_jobs')
    .insert({ athlete_id: athleteId, video_url: videoUrl, status: 'queued', version: null, kind })
    .select('*')
    .single();
  if (error) throw error;
  return data as VisionJob;
}

/** Read the talent estimate for the passport. Honest: model DARK until CW15 produces output. */
export async function getTalentEstimate(athleteId: string, accessToken: string | null): Promise<TalentEstimate> {
  const empty: TalentEstimate = { athlete_id: athleteId, composite: null, skills: [], computed_at: null, model_dark: true };
  if (!supabaseEnabled) {
    const rows = (mock.talentIndex ?? []).filter((t) => t.athlete_id === athleteId);
    if (rows.length === 0) return empty;
    return composeTalent(athleteId, rows);
  }
  const { data, error } = await reader(accessToken)
    .from('sports_talent_index')
    .select('*')
    .eq('athlete_id', athleteId);
  if (error) throw error;
  if (!data || data.length === 0) return empty;
  return composeTalent(athleteId, data as TalentRow[]);
}

interface TalentRow { athlete_id: string; skill: string; composite: number; computed_at: string; model_version?: string | null; confidence?: number | null; }

function composeTalent(athleteId: string, rows: TalentRow[]): TalentEstimate {
  const mk = (value: number, mv: string | null, conf: number | null, when: string): Estimate => ({
    value, confidence: conf ?? 0.5, estimate: true, source: 'talent', model_version: mv ?? null,
    generated_at: when, human_reviewed: false,
  });
  const composite = rows.find((r) => r.skill === 'composite') ?? rows[0];
  return {
    athlete_id: athleteId,
    composite: mk(composite.composite, composite.model_version ?? null, composite.confidence ?? null, composite.computed_at),
    skills: rows.filter((r) => r.skill !== 'composite').map((r) => ({ name: r.skill, estimate: mk(r.composite, r.model_version ?? null, r.confidence ?? null, r.computed_at) })),
    computed_at: composite.computed_at,
    model_dark: !composite.model_version, // if no model_version, it's a placeholder
  };
}

/** Highlights for the passport (CW15 vision_outputs of type 'highlight'). Honest empty. */
export async function getHighlights(athleteId: string, accessToken: string | null): Promise<Highlight[]> {
  if (!supabaseEnabled) {
    return (mock.highlights ?? []).filter((h) => h.athlete_id === athleteId);
  }
  const { data, error } = await reader(accessToken)
    .from('sports_vision_outputs')
    .select('id, job_id, type, data_json, created_at, sports_vision_jobs!inner(athlete_id)')
    .eq('type', 'highlight')
    .eq('sports_vision_jobs.athlete_id', athleteId);
  if (error) throw error;
  return ((data as VisionOutputRow[]) ?? []).map((o) => ({
    id: o.id, athlete_id: athleteId, job_id: o.job_id,
    title: o.data_json?.title ?? 'Highlight',
    clip_url: o.data_json?.clip_url ?? '',
    thumb_url: o.data_json?.thumb_url ?? null,
    created_at: o.created_at,
  }));
}
interface VisionOutputRow { id: string; job_id: string; type: string; data_json: { title?: string; clip_url?: string; thumb_url?: string }; created_at: string; }

/** Composed recruiting/exposure profile (scout-facing). RLS decides if the row is visible. */
export async function getRecruitingProfile(athleteId: string, accessToken: string | null): Promise<RecruitingProfile | null> {
  const athlete = await getAthlete(athleteId, accessToken);
  if (!athlete) return null; // hidden by RLS or absent — caller gets 404, no leak
  const [stats, perfs, talent, highlights] = await Promise.all([
    getStats(athleteId, accessToken),
    getPerformances(athleteId, accessToken),
    getTalentEstimate(athleteId, accessToken),
    getHighlights(athleteId, accessToken),
  ]);
  const totRuns = perfs.reduce((s, p) => s + p.runs, 0);
  const totWkts = perfs.reduce((s, p) => s + p.wickets, 0);
  const season = stats[0];
  return {
    athlete_id: athleteId,
    name_ref: athlete.user_id,
    sport: athlete.sport,
    role: athlete.role,
    state: athlete.state,
    district: athlete.district,
    verified: athlete.verified_status === 'human_verified',
    visibility: athlete.visibility,
    headline_stats: [
      { label: 'Matches', value: season?.matches ?? perfs.length },
      { label: 'Runs', value: season?.runs ?? totRuns },
      { label: 'Wickets', value: season?.wickets ?? totWkts },
      { label: 'Avg', value: season?.avg ?? '—' },
    ],
    talent,
    highlights,
    share_url: `${SHARE_BASE}/${athleteId}`,
  };
}

/* ---- v3.0: Career GPS · Digital Twin · Agent · Selection History ---- */
import type { CareerGPS, DigitalTwin, AgentPing, SelectionRecord, PathwayLevel } from '../lib/types';

const VERIFY_BASE = process.env.PUBLIC_VERIFY_BASE || 'https://verify.dcsai.ai';

const PATHWAY: { key: string; label: string }[] = [
  { key: 'club', label: 'Club / Academy' },
  { key: 'district', label: 'District' },
  { key: 'state', label: 'State' },
  { key: 'domestic', label: 'Domestic (Ranji)' },
  { key: 'national', label: 'National' },
];

/**
 * Career GPS — a conservative, estimate-labeled pathway. We infer the current
 * level from verified selection records (highest reached); the plan is guidance,
 * never a guarantee. Data-gated: with little real data we say so plainly.
 */
export async function getCareerGPS(athleteId: string, accessToken: string | null): Promise<CareerGPS | null> {
  const athlete = await getAthlete(athleteId, accessToken);
  if (!athlete) return null;
  const [records, perfs] = await Promise.all([
    getSelectionHistory(athleteId, accessToken),
    getPerformances(athleteId, accessToken),
  ]);
  // highest reached level from verified records; default to 'club'.
  const reachedKeys = new Set(records.map((r) => r.level));
  let currentIdx = 0;
  PATHWAY.forEach((p, i) => { if (reachedKeys.has(p.key)) currentIdx = Math.max(currentIdx, i); });
  const levels: PathwayLevel[] = PATHWAY.map((p, i) => ({
    key: p.key, label: p.label, reached: i <= currentIdx, current: i === currentIdx,
  }));
  const next = PATHWAY[currentIdx + 1] ?? null;
  const dataGated = perfs.length < 3; // not enough match data for meaningful guidance
  const matches = perfs.length;
  const runs = perfs.reduce((s, p) => s + p.runs, 0);

  return {
    athlete_id: athleteId,
    levels,
    current_level: PATHWAY[currentIdx].key,
    next_milestone: next ? { label: `Selection at ${next.label}`, level: next.key } : null,
    gaps: dataGated
      ? [{ area: 'match data', note: 'Log at least a few matches so guidance can be meaningful.' }]
      : [
          { area: 'consistency', note: `${matches} matches logged · ${runs} runs. Sustained output across a season strengthens selection cases.` },
          { area: 'exposure', note: 'A discoverable, verified profile helps scouts find you.' },
        ],
    plan: next
      ? [
          { step: `Target ${next.label}-level matches/trials`, rationale: 'Selectors look for performance at the next rung.' },
          { step: 'Keep your passport verified and up to date', rationale: 'Verified records carry weight in selection.' },
        ]
      : [{ step: 'Sustain national-level performance', rationale: 'You are at the top rung of the modeled pathway.' }],
    estimate: true,
    confidence: dataGated ? 0.3 : 0.55,
    data_gated: dataGated,
  };
}

/** Digital Twin v0 — conservative, data-gated. Never invents an injury number. */
export async function getDigitalTwin(athleteId: string, accessToken: string | null): Promise<DigitalTwin | null> {
  const athlete = await getAthlete(athleteId, accessToken);
  if (!athlete) return null;
  const perfs = await getPerformances(athleteId, accessToken);
  const recent = perfs.length;
  const gated = recent < 4;
  const trend: DigitalTwin['workload']['trend'] = gated ? 'insufficient' : 'flat';
  return {
    athlete_id: athleteId,
    workload: { recent_matches: recent, trend },
    injury_risk: gated
      ? { band: 'insufficient', estimate: true, confidence: 0.2 }
      : { band: 'low', estimate: true, confidence: 0.4 },
    notes: gated
      ? ['Not enough match/workload data yet to model trends or risk. This fills in as you log matches.']
      : ['Workload modeling is conservative and indicative — not medical advice.'],
    data_gated: gated,
  };
}

/** Agent pings (human-gated). CW10 surfaces sports_agent_suggestions; user acts, agent never does. */
export async function getAgentPings(athleteId: string, accessToken: string | null): Promise<AgentPing[]> {
  if (!supabaseEnabled) {
    return (mock.agentPings ?? []).filter((p) => p.athlete_id === athleteId);
  }
  const { data, error } = await reader(accessToken)
    .from('sports_agent_suggestions')
    .select('*')
    .eq('subject_type', 'athlete')
    .eq('subject_id', athleteId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data as AgentRow[]) ?? []).map((r) => ({
    id: r.id, athlete_id: athleteId, agent: r.agent,
    title: r.payload_json?.title ?? 'Suggestion',
    body: r.payload_json?.body ?? '',
    high_stakes: r.high_stakes, status: r.status, created_at: r.created_at,
  }));
}
interface AgentRow { id: string; agent: string; payload_json: { title?: string; body?: string }; high_stakes: boolean; status: AgentPing['status']; created_at: string; }

/** Acknowledge/dismiss a ping (user action; the only state the agent's suggestion can take here). */
export async function setPingStatus(pingId: string, status: AgentPing['status']): Promise<boolean> {
  if (!supabaseEnabled) {
    const p = (mock.agentPings ?? []).find((x) => x.id === pingId);
    if (p) p.status = status;
    return !!p;
  }
  const { error } = await serviceClient().from('sports_agent_suggestions').update({ status }).eq('id', pingId);
  if (error) throw error;
  return true;
}

/** Verified Selection History — signed records from CW13 (sports_verifications). */
export async function getSelectionHistory(athleteId: string, accessToken: string | null): Promise<SelectionRecord[]> {
  if (!supabaseEnabled) {
    return (mock.selectionRecords ?? []).filter((r) => r.athlete_id === athleteId);
  }
  const { data, error } = await reader(accessToken)
    .from('sports_verifications')
    .select('id, entity_id, status, verified_by, ts, sig, evidence_url')
    .eq('entity_type', 'athlete')
    .eq('entity_id', athleteId)
    .eq('status', 'human_verified');
  if (error) throw error;
  return ((data as VerificationRow[]) ?? []).map((v) => ({
    id: v.id, athlete_id: athleteId,
    title: v.evidence_url ? 'Verified selection' : 'Verified record',
    level: 'state', date: v.ts, verified_by: v.verified_by, sig: v.sig,
    verify_url: `${VERIFY_BASE}/${v.id}`,
  }));
}
interface VerificationRow { id: string; entity_id: string; status: string; verified_by: string | null; ts: string; sig: string | null; evidence_url: string | null; }
