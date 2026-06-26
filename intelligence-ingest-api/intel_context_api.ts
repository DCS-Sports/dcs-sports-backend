/**
 * intel_context_api.ts — GET /intel/context
 * The Claude integration endpoint. Every Claude session calls this first.
 * Returns a structured JSON snapshot: campaign, tasks, analytics, SEO, social,
 * pending approvals, and (optionally) open browser tabs passed by the caller.
 *
 * Source: analytics patterns from CW4/src/analytics/analytics-api.js (getDashboardData)
 * Security: JWT auth · no money/autonomy · all *_LIVE=0 until Phase 4
 */

import { SupabaseClient } from '@supabase/supabase-js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IntelContext {
  generated_at: string;
  campaign: ActiveCampaignSummary | null;
  today_tasks: TaskSummary[];
  analytics: AnalyticsSnapshot;
  seo: SeoSnapshot;
  social: SocialSnapshot;
  agents: AgentSnapshot;
  pending_approvals: ApprovalItem[];
  open_tabs: string[];         // passed by caller (Claude Chrome extension)
  recommendation: string | null;
  companies: string[];
}

export interface ActiveCampaignSummary {
  id: string;
  name: string;
  company: string;
  pct_complete: number;
  target_date: string | null;
  pending_channels: string[];
}

export interface TaskSummary {
  id: string;
  title: string;
  assigned_cw: string | null;
  status: 'assigned' | 'working' | 'waiting_review' | 'done' | 'blocked';
  blocker: boolean;
  hours_waiting: number | null;
}

export interface AnalyticsSnapshot {
  visitors_7d: number;
  visitors_trend: string;   // '+31%' | '-5%' | 'flat'
  top_page: string | null;
  signups_7d: number;
  active_runs: number;
  today_cost_usd: string;
}

export interface SeoSnapshot {
  top_opportunity: string | null;
  searches_up_pct: number | null;
  gsc_clicks_7d: number;
  gsc_impressions_7d: number;
}

export interface SocialSnapshot {
  linkedin_followers: number | null;
  x_followers: number | null;
  youtube_subs: number | null;
  top_platform: string | null;
}

export interface AgentSnapshot {
  active_cw: number;
  waiting_review: number;
  blocked: number;
  total_runs_7d: number;
}

export interface ApprovalItem {
  type: 'content' | 'seo_report' | 'campaign' | 'deploy';
  label: string;
  cw: string | null;
  hours_waiting: number;
}

// ── Context builder ───────────────────────────────────────────────────────────

/**
 * buildIntelContext
 * Core aggregator — mirrors getDashboardData() from CW4 analytics-api.js but
 * cross-joins campaigns, tasks, and social into one structured payload for Claude.
 */
export async function buildIntelContext(
  db: SupabaseClient,
  userId: string,
  opts: { openTabs?: string[]; company?: string } = {},
): Promise<IntelContext> {
  const now = new Date().toISOString();

  const [
    campaignResult,
    tasksResult,
    analyticsResult,
    agentRunsResult,
    approvalsResult,
    socialResult,
  ] = await Promise.allSettled([
    getActiveCampaign(db, userId, opts.company),
    getTodayTasks(db, userId),
    getAnalyticsSnapshot(db, userId),
    getAgentSnapshot(db, userId),
    getPendingApprovals(db, userId),
    getSocialSnapshot(db, userId),
  ]);

  const campaign = campaignResult.status === 'fulfilled' ? campaignResult.value : null;
  const tasks    = tasksResult.status === 'fulfilled'    ? tasksResult.value : [];
  const analytics = analyticsResult.status === 'fulfilled' ? analyticsResult.value : emptyAnalytics();
  const agents   = agentRunsResult.status === 'fulfilled' ? agentRunsResult.value : emptyAgents();
  const approvals = approvalsResult.status === 'fulfilled' ? approvalsResult.value : [];
  const social   = socialResult.status === 'fulfilled'   ? socialResult.value : emptySocial();

  // Generate one-line recommendation from context
  const recommendation = generateRecommendation({ campaign, tasks, analytics, approvals });

  return {
    generated_at: now,
    campaign,
    today_tasks: tasks,
    analytics,
    seo: await getSeoSnapshot(db, userId),
    social,
    agents,
    pending_approvals: approvals,
    open_tabs: opts.openTabs ?? [],
    recommendation,
    companies: ['TRD', 'DCS AI', 'DCS Labs', 'DCS Rank', 'DCS Sports', 'DCS Games'],
  };
}

// ── Sub-fetchers ──────────────────────────────────────────────────────────────

async function getActiveCampaign(
  db: SupabaseClient,
  userId: string,
  company?: string,
): Promise<ActiveCampaignSummary | null> {
  let q = db
    .from('intel_campaigns')
    .select('id, name, company, pct_complete, target_date, channel_status')
    .eq('created_by', userId)
    .eq('status', 'active')
    .order('target_date', { ascending: true })
    .limit(1);

  if (company) q = q.eq('company', company);

  const { data } = await q.maybeSingle();
  if (!data) return null;

  const channelStatus: Record<string, string> = data.channel_status ?? {};
  const pendingChannels = Object.entries(channelStatus)
    .filter(([, v]) => v === 'pending' || v === 'draft')
    .map(([k]) => k);

  return {
    id: data.id,
    name: data.name,
    company: data.company,
    pct_complete: data.pct_complete ?? 0,
    target_date: data.target_date ?? null,
    pending_channels: pendingChannels,
  };
}

async function getTodayTasks(
  db: SupabaseClient,
  userId: string,
): Promise<TaskSummary[]> {
  const { data } = await db
    .from('intel_tasks')
    .select('id, title, assigned_cw, status, blocker, updated_at')
    .eq('created_by', userId)
    .neq('status', 'done')
    .order('updated_at', { ascending: false })
    .limit(20);

  if (!data) return [];

  const now = Date.now();
  return data.map((t: any) => ({
    id: t.id,
    title: t.title,
    assigned_cw: t.assigned_cw ?? null,
    status: t.status,
    blocker: t.blocker ?? false,
    hours_waiting: t.updated_at
      ? Math.round((now - new Date(t.updated_at).getTime()) / 3_600_000)
      : null,
  }));
}

/**
 * getAnalyticsSnapshot — adapted from CW4 getOverviewMetrics + getCostTrends
 */
async function getAnalyticsSnapshot(
  db: SupabaseClient,
  userId: string,
): Promise<AnalyticsSnapshot> {
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const since14d = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [visits7d, visits14d, signups, runs, cost] = await Promise.all([
    db.from('dcs_events').select('*', { count: 'exact', head: true })
      .gte('ts', since7d).eq('event', 'pageview'),
    db.from('dcs_events').select('*', { count: 'exact', head: true })
      .gte('ts', since14d).lt('ts', since7d).eq('event', 'pageview'),
    db.from('dcs_identities').select('*', { count: 'exact', head: true })
      .gte('first_seen', since7d),
    db.from('av2_tasks').select('*', { count: 'exact', head: true })
      .eq('status', 'running'),
    db.from('agentic_ledger_entries').select('total_usd_cents')
      .gte('created_at', todayStart.toISOString()).eq('success', true),
  ]);

  const v7 = visits7d.count ?? 0;
  const v14 = visits14d.count ?? 0;
  const trend = v14 === 0 ? 'flat'
    : v7 > v14 ? `+${Math.round(((v7 - v14) / v14) * 100)}%`
    : `-${Math.round(((v14 - v7) / v14) * 100)}%`;

  const todayCostCents = (cost.data ?? []).reduce(
    (s: number, e: any) => s + (e.total_usd_cents ?? 0), 0
  );

  return {
    visitors_7d: v7,
    visitors_trend: trend,
    top_page: null, // populated by PostHog connector when live
    signups_7d: signups.count ?? 0,
    active_runs: runs.count ?? 0,
    today_cost_usd: (todayCostCents / 100).toFixed(2),
  };
}

async function getSeoSnapshot(
  db: SupabaseClient,
  _userId: string,
): Promise<SeoSnapshot> {
  // Pull from intel_memory where key = 'seo_opportunity' if available
  const { data } = await db
    .from('intel_memory')
    .select('value')
    .eq('key', 'seo_opportunity')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const mem = data?.value as any ?? {};
  return {
    top_opportunity: mem.top_keyword ?? null,
    searches_up_pct: mem.searches_up_pct ?? null,
    gsc_clicks_7d: mem.gsc_clicks_7d ?? 0,
    gsc_impressions_7d: mem.gsc_impressions_7d ?? 0,
  };
}

async function getSocialSnapshot(
  db: SupabaseClient,
  _userId: string,
): Promise<SocialSnapshot> {
  const { data } = await db
    .from('intel_social_snapshots')
    .select('platform, followers')
    .order('snapped_at', { ascending: false })
    .limit(10);

  if (!data) return emptySocial();

  const byPlatform: Record<string, number> = {};
  for (const row of data) {
    if (!(row.platform in byPlatform)) byPlatform[row.platform] = row.followers ?? 0;
  }

  const topPlatform = Object.entries(byPlatform).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    linkedin_followers: byPlatform['linkedin'] ?? null,
    x_followers: byPlatform['x'] ?? null,
    youtube_subs: byPlatform['youtube'] ?? null,
    top_platform: topPlatform,
  };
}

async function getAgentSnapshot(
  db: SupabaseClient,
  _userId: string,
): Promise<AgentSnapshot> {
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [active, review, blocked, total] = await Promise.all([
    db.from('av2_tasks').select('*', { count: 'exact', head: true }).eq('status', 'running'),
    db.from('av2_tasks').select('*', { count: 'exact', head: true }).eq('status', 'waiting_review'),
    db.from('av2_tasks').select('*', { count: 'exact', head: true }).eq('status', 'blocked'),
    db.from('av2_tasks').select('*', { count: 'exact', head: true }).gte('created_at', since7d),
  ]);
  return {
    active_cw: active.count ?? 0,
    waiting_review: review.count ?? 0,
    blocked: blocked.count ?? 0,
    total_runs_7d: total.count ?? 0,
  };
}

async function getPendingApprovals(
  db: SupabaseClient,
  userId: string,
): Promise<ApprovalItem[]> {
  const { data } = await db
    .from('intel_tasks')
    .select('title, assigned_cw, updated_at, task_type')
    .eq('created_by', userId)
    .eq('status', 'waiting_review')
    .order('updated_at', { ascending: true })
    .limit(10);

  if (!data) return [];
  const now = Date.now();
  return data.map((t: any) => ({
    type: t.task_type ?? 'content',
    label: t.title,
    cw: t.assigned_cw ?? null,
    hours_waiting: t.updated_at
      ? Math.round((now - new Date(t.updated_at).getTime()) / 3_600_000)
      : 0,
  }));
}

// ── Recommendation engine ─────────────────────────────────────────────────────

function generateRecommendation(ctx: {
  campaign: ActiveCampaignSummary | null;
  tasks: TaskSummary[];
  analytics: AnalyticsSnapshot;
  approvals: ApprovalItem[];
}): string | null {
  // Priority 1: blocked task waiting > 24hrs
  const blocked = ctx.tasks.find(t => t.blocker && (t.hours_waiting ?? 0) > 24);
  if (blocked) return `Unblock "${blocked.title}" — has been waiting ${blocked.hours_waiting}hrs.`;

  // Priority 2: approval waiting > 12hrs
  const stale = ctx.approvals.find(a => a.hours_waiting > 12);
  if (stale) return `Review "${stale.label}" — waiting ${stale.hours_waiting}hrs for approval.`;

  // Priority 3: SEO opportunity from memory
  // (populated by marketing memory cron — see intel_marketing_memory.ts)
  return null;
}

// ── Fallbacks ─────────────────────────────────────────────────────────────────

function emptyAnalytics(): AnalyticsSnapshot {
  return { visitors_7d: 0, visitors_trend: 'flat', top_page: null, signups_7d: 0, active_runs: 0, today_cost_usd: '0.00' };
}
function emptyAgents(): AgentSnapshot {
  return { active_cw: 0, waiting_review: 0, blocked: 0, total_runs_7d: 0 };
}
function emptySocial(): SocialSnapshot {
  return { linkedin_followers: null, x_followers: null, youtube_subs: null, top_platform: null };
}

// ── HTTP route ────────────────────────────────────────────────────────────────

/**
 * registerIntelContextRoute
 * Mount in intelligence-ingest-api Express/Hono app.
 *
 * GET /intel/context
 *   → Returns IntelContext JSON
 *   → Claude calls this at the start of every session
 *   → Supports ?company=TRD&tabs=url1,url2 query params
 */
export function registerIntelContextRoute(app: any, db: SupabaseClient) {
  app.get('/intel/context', async (req: any, res: any) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const company = req.query.company as string | undefined;
    const openTabs = req.query.tabs
      ? (req.query.tabs as string).split(',').map((t: string) => t.trim())
      : [];

    try {
      const ctx = await buildIntelContext(db, userId, { openTabs, company });
      res.json(ctx);
    } catch (e: any) {
      console.error('[IntelContext] error', e?.message);
      res.status(500).json({ error: 'context_build_failed' });
    }
  });

  // POST /intel/context/tabs — Chrome extension pushes open tabs
  app.post('/intel/context/tabs', async (req: any, res: any) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    const { tabs } = req.body ?? {};
    if (!Array.isArray(tabs)) return res.status(400).json({ error: 'tabs must be array' });
    // Store for next /intel/context call
    await db.from('intel_chrome_tabs').upsert({
      user_id: userId,
      tabs,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    res.json({ ok: true, count: tabs.length });
  });
}
