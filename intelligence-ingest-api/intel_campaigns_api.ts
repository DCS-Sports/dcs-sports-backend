/**
 * intel_campaigns_api.ts — Campaign OS routes + Supabase SQL migrations
 * Full campaign lifecycle: create → assign → track → complete → learn
 *
 * Source: CW1/src/campaigns/swarm.js (createCampaignManager, createCampaign)
 *         CW1/src/growth/scheduler.js (createScheduler, dark scheduling)
 * Security: POST_LIVE=0 (scheduling records intent only, never auto-posts)
 *           AUTONOMY_LIVE=0 · no money
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'complete' | 'archived';
export type TaskStatus = 'assigned' | 'working' | 'waiting_review' | 'published' | 'done' | 'blocked';
export type Company = 'TRD' | 'DCS AI' | 'DCS Labs' | 'DCS Rank' | 'DCS Sports' | 'DCS Games';

export const CHANNELS = [
  'medium', 'linkedin', 'x', 'youtube', 'hashnode', 'devto',
  'newsletter', 'discord', 'product_hunt', 'github', 'press_kit', 'seo',
] as const;
export type Channel = typeof CHANNELS[number];

export interface Campaign {
  id: string;
  name: string;
  company: Company;
  goal: string;
  status: CampaignStatus;
  pct_complete: number;
  target_date: string | null;
  channel_status: Record<Channel, 'pending' | 'draft' | 'review' | 'published' | 'skipped'>;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  learnings: CampaignLearning | null;
}

export interface CampaignTask {
  id: string;
  campaign_id: string;
  title: string;
  task_type: 'content' | 'seo_report' | 'image' | 'social' | 'video' | 'email' | 'pr' | 'deploy';
  assigned_cw: string | null;
  channel: Channel | null;
  status: TaskStatus;
  blocker: boolean;
  content_url: string | null;
  gpt_quality_score: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignLearning {
  best_channel: Channel | null;
  best_day: string | null;
  best_hour: number | null;
  total_views: number;
  total_signups: number;
  notes: string;
}

// ── SQL Migrations ────────────────────────────────────────────────────────────

export const INTEL_V2_MIGRATIONS_SQL = `
-- ============================================================
-- Intel v2 Supabase Migrations
-- Run in Supabase SQL editor (DK: Settings → SQL Editor)
-- ============================================================

-- intel_campaigns
create table if not exists intel_campaigns (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  company       text not null check (company in ('TRD','DCS AI','DCS Labs','DCS Rank','DCS Sports','DCS Games')),
  goal          text not null,
  status        text not null default 'draft' check (status in ('draft','active','paused','complete','archived')),
  pct_complete  integer not null default 0 check (pct_complete between 0 and 100),
  target_date   date,
  channel_status jsonb not null default '{}',
  created_by    uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz,
  learnings     jsonb
);
create index if not exists intel_campaigns_user_status on intel_campaigns (created_by, status);
create index if not exists intel_campaigns_company on intel_campaigns (company);

-- intel_tasks
create table if not exists intel_tasks (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid references intel_campaigns(id) on delete cascade,
  title             text not null,
  task_type         text not null default 'content'
    check (task_type in ('content','seo_report','image','social','video','email','pr','deploy')),
  assigned_cw       text,
  channel           text check (channel in ('medium','linkedin','x','youtube','hashnode','devto','newsletter','discord','product_hunt','github','press_kit','seo')),
  status            text not null default 'assigned'
    check (status in ('assigned','working','waiting_review','published','done','blocked')),
  blocker           boolean not null default false,
  content_url       text,
  gpt_quality_score smallint check (gpt_quality_score between 1 and 10),
  created_by        uuid not null references auth.users(id) on delete cascade,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists intel_tasks_campaign on intel_tasks (campaign_id);
create index if not exists intel_tasks_user_status on intel_tasks (created_by, status);
create index if not exists intel_tasks_assigned_cw on intel_tasks (assigned_cw);

-- intel_memory (Marketing Memory)
create table if not exists intel_memory (
  id           uuid primary key default gen_random_uuid(),
  company      text not null,
  key          text not null,   -- 'best_day', 'best_hour', 'best_title_format', 'seo_opportunity' etc
  value        jsonb not null,
  source       text,            -- 'cron', 'campaign_debrief', 'manual'
  updated_at   timestamptz not null default now(),
  unique(company, key)
);

-- intel_social_snapshots
create table if not exists intel_social_snapshots (
  id         uuid primary key default gen_random_uuid(),
  company    text not null,
  platform   text not null,
  followers  integer,
  impressions_7d integer,
  top_post   text,
  snapped_at timestamptz not null default now()
);
create index if not exists intel_social_snap_company on intel_social_snapshots (company, platform, snapped_at desc);

-- intel_morning_brief
create table if not exists intel_morning_brief (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  metrics        jsonb not null,
  recommendation text,
  claude_prompt  text,
  generated_at   timestamptz not null default now()
);
create index if not exists intel_brief_user on intel_morning_brief (user_id, generated_at desc);

-- intel_chrome_tabs
create table if not exists intel_chrome_tabs (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  tabs       text[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- intel_cw_quality
create table if not exists intel_cw_quality (
  id               uuid primary key default gen_random_uuid(),
  cw_id            text not null,
  task_id          uuid references intel_tasks(id) on delete set null,
  campaign_id      uuid references intel_campaigns(id) on delete set null,
  gpt_score        smallint check (gpt_score between 1 and 10),
  tokens_used      integer,
  cost_usd_cents   integer,
  wall_time_ms     integer,
  created_at       timestamptz not null default now()
);
create index if not exists intel_cw_quality_cw on intel_cw_quality (cw_id, created_at desc);

-- content library
create table if not exists intel_content (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid references intel_campaigns(id) on delete set null,
  task_id        uuid references intel_tasks(id) on delete set null,
  title          text not null,
  platform       text not null,
  company        text not null,
  author_cw      text,
  gpt_reviewed   boolean not null default false,
  published_at   timestamptz,
  url            text,
  performance    jsonb,   -- {views, read_time_s, ctr, backlinks, signups, revenue_usd}
  created_at     timestamptz not null default now()
);
create index if not exists intel_content_company on intel_content (company, platform, published_at desc);

-- updated_at triggers
create or replace function intel_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'intel_campaigns_updated_at') then
    create trigger intel_campaigns_updated_at before update on intel_campaigns
      for each row execute function intel_set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'intel_tasks_updated_at') then
    create trigger intel_tasks_updated_at before update on intel_tasks
      for each row execute function intel_set_updated_at();
  end if;
end $$;
`;

// ── Campaign manager (adapted from CW1 createCampaignManager) ─────────────────

export function createIntelCampaignManager(db: SupabaseClient) {
  /**
   * createCampaign — adapted from CW1/src/campaigns/swarm.js createCampaign
   * Records intent; never auto-posts (POST_LIVE=0).
   */
  async function createCampaign(params: {
    userId: string;
    name: string;
    company: Company;
    goal: string;
    channels: Channel[];
    targetDate?: string;
  }) {
    const { userId, name, company, goal, channels, targetDate } = params;
    if (!goal || !name || !company) return { ok: false, error: 'missing_required_fields' };

    const channelStatus = Object.fromEntries(
      channels.map(c => [c, 'pending'])
    ) as Record<Channel, 'pending'>;

    const { data, error } = await db.from('intel_campaigns').insert({
      id: randomUUID(),
      name, company, goal,
      status: 'draft',
      pct_complete: 0,
      target_date: targetDate ?? null,
      channel_status: channelStatus,
      created_by: userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).select().single();

    if (error) return { ok: false, error: error.message };
    return { ok: true, campaign: data as Campaign };
  }

  async function activateCampaign(campaignId: string, userId: string) {
    const { data, error } = await db
      .from('intel_campaigns')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', campaignId)
      .eq('created_by', userId)
      .select().single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, campaign: data as Campaign };
  }

  async function addTask(params: {
    campaignId: string;
    userId: string;
    title: string;
    taskType: CampaignTask['task_type'];
    assignedCw: string;
    channel?: Channel;
  }) {
    const { data, error } = await db.from('intel_tasks').insert({
      id: randomUUID(),
      campaign_id: params.campaignId,
      title: params.title,
      task_type: params.taskType,
      assigned_cw: params.assignedCw,
      channel: params.channel ?? null,
      status: 'assigned',
      blocker: false,
      created_by: params.userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).select().single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, task: data as CampaignTask };
  }

  async function updateTaskStatus(
    taskId: string,
    userId: string,
    status: TaskStatus,
    extras: { contentUrl?: string; gptQualityScore?: number; blocker?: boolean } = {},
  ) {
    const update: Record<string, any> = { status, updated_at: new Date().toISOString() };
    if (extras.contentUrl !== undefined) update.content_url = extras.contentUrl;
    if (extras.gptQualityScore !== undefined) update.gpt_quality_score = extras.gptQualityScore;
    if (extras.blocker !== undefined) update.blocker = extras.blocker;

    const { data, error } = await db
      .from('intel_tasks')
      .update(update)
      .eq('id', taskId)
      .eq('created_by', userId)
      .select().single();

    if (error) return { ok: false, error: error.message };

    // Recalculate campaign % complete
    if (data?.campaign_id) await recalcPctComplete(db, data.campaign_id);

    return { ok: true, task: data as CampaignTask };
  }

  async function completeCampaign(
    campaignId: string,
    userId: string,
    learnings: CampaignLearning,
  ) {
    const { data, error } = await db
      .from('intel_campaigns')
      .update({
        status: 'complete',
        pct_complete: 100,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        learnings,
      })
      .eq('id', campaignId)
      .eq('created_by', userId)
      .select().single();
    if (error) return { ok: false, error: error.message };

    // Push learnings into Marketing Memory
    await writeCampaignLearnings(db, data as Campaign, learnings);
    return { ok: true, campaign: data as Campaign };
  }

  async function listCampaigns(userId: string, status?: CampaignStatus, company?: Company) {
    let q = db.from('intel_campaigns')
      .select('*')
      .eq('created_by', userId)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (status) q = q.eq('status', status);
    if (company) q = q.eq('company', company);
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    return { ok: true, campaigns: data as Campaign[] };
  }

  return { createCampaign, activateCampaign, addTask, updateTaskStatus, completeCampaign, listCampaigns };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function recalcPctComplete(db: SupabaseClient, campaignId: string) {
  const { data } = await db
    .from('intel_tasks')
    .select('status')
    .eq('campaign_id', campaignId);
  if (!data?.length) return;
  const done = data.filter((t: any) => t.status === 'done' || t.status === 'published').length;
  const pct = Math.round((done / data.length) * 100);
  await db.from('intel_campaigns')
    .update({ pct_complete: pct, updated_at: new Date().toISOString() })
    .eq('id', campaignId);
}

async function writeCampaignLearnings(
  db: SupabaseClient,
  campaign: Campaign,
  learnings: CampaignLearning,
) {
  if (!learnings.best_channel) return;
  await db.from('intel_memory').upsert({
    company: campaign.company,
    key: `campaign_best_channel_${campaign.company.toLowerCase().replace(/ /g, '_')}`,
    value: { channel: learnings.best_channel, views: learnings.total_views, signups: learnings.total_signups },
    source: 'campaign_debrief',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'company,key' });
}

// ── HTTP routes ───────────────────────────────────────────────────────────────

/**
 * registerCampaignRoutes
 *
 * POST   /intel/campaigns            → create campaign
 * GET    /intel/campaigns            → list campaigns
 * PATCH  /intel/campaigns/:id/activate
 * POST   /intel/campaigns/:id/tasks  → add task
 * PATCH  /intel/tasks/:id            → update task status
 * POST   /intel/campaigns/:id/complete → complete + write learnings
 */
export function registerCampaignRoutes(app: any, db: SupabaseClient) {
  const mgr = createIntelCampaignManager(db);

  const uid = (req: any) => req.user?.id;
  const auth = (req: any, res: any) => {
    if (!uid(req)) { res.status(401).json({ error: 'unauthenticated' }); return false; }
    return true;
  };

  app.post('/intel/campaigns', async (req: any, res: any) => {
    if (!auth(req, res)) return;
    const { name, company, goal, channels = [], targetDate } = req.body ?? {};
    if (!name || !company || !goal) return res.status(400).json({ error: 'name, company, goal required' });
    const r = await mgr.createCampaign({ userId: uid(req), name, company, goal, channels, targetDate });
    res.status(r.ok ? 201 : 400).json(r);
  });

  app.get('/intel/campaigns', async (req: any, res: any) => {
    if (!auth(req, res)) return;
    const r = await mgr.listCampaigns(uid(req), req.query.status, req.query.company);
    res.json(r);
  });

  app.patch('/intel/campaigns/:id/activate', async (req: any, res: any) => {
    if (!auth(req, res)) return;
    const r = await mgr.activateCampaign(req.params.id, uid(req));
    res.json(r);
  });

  app.post('/intel/campaigns/:id/tasks', async (req: any, res: any) => {
    if (!auth(req, res)) return;
    const { title, taskType = 'content', assignedCw, channel } = req.body ?? {};
    if (!title || !assignedCw) return res.status(400).json({ error: 'title + assignedCw required' });
    const r = await mgr.addTask({
      campaignId: req.params.id, userId: uid(req),
      title, taskType, assignedCw, channel,
    });
    res.status(r.ok ? 201 : 400).json(r);
  });

  app.patch('/intel/tasks/:id', async (req: any, res: any) => {
    if (!auth(req, res)) return;
    const { status, contentUrl, gptQualityScore, blocker } = req.body ?? {};
    if (!status) return res.status(400).json({ error: 'status required' });
    const r = await mgr.updateTaskStatus(req.params.id, uid(req), status, { contentUrl, gptQualityScore, blocker });
    res.json(r);
  });

  app.post('/intel/campaigns/:id/complete', async (req: any, res: any) => {
    if (!auth(req, res)) return;
    const { learnings } = req.body ?? {};
    if (!learnings) return res.status(400).json({ error: 'learnings required' });
    const r = await mgr.completeCampaign(req.params.id, uid(req), learnings);
    res.json(r);
  });
}
