/**
 * intel_marketing_memory.ts — Marketing Memory pattern writer
 * Reads analytics history, content performance, and campaign outcomes.
 * Writes learnings to intel_memory table. Gets smarter every month.
 *
 * Source: CW1/src/memory/graph.js (createMemoryGraph — scope/type/outcome pattern)
 *         CW4/src/analytics/ledger-aggregator.js (getDailyCostBreakdown pattern)
 * Security: read-only analytics access · no posting · AUTONOMY_LIVE=0
 *
 * Schedule: run daily at 3am via intel_morning_brief cron (or Railway cron trigger)
 */

import { SupabaseClient } from '@supabase/supabase-js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryPattern {
  company: string;
  key: string;
  value: Record<string, unknown>;
  source: 'cron' | 'campaign_debrief' | 'manual';
}

export interface ContentPerformance {
  platform: string;
  views: number;
  read_time_s: number;
  ctr: number;
  backlinks: number;
  signups: number;
  published_at: string;
  title_format: string | null;
}

export interface DayHourPattern {
  day: string;     // 'Monday' .. 'Sunday'
  hour: number;    // 0-23 UTC
  avg_views: number;
  sample_count: number;
}

// ── Core pattern learner ──────────────────────────────────────────────────────

/**
 * runMarketingMemoryCron
 * Main entry — runs daily. Learns patterns from all past content + campaigns.
 * Writes to intel_memory (upsert — same key = update, never duplicate).
 *
 * Mirrors createMemoryGraph() from CW1: uses scope (company) + type (key) + value (outcome).
 */
export async function runMarketingMemoryCron(
  db: SupabaseClient,
  companies: string[] = ['TRD', 'DCS AI', 'DCS Labs', 'DCS Rank', 'DCS Sports', 'DCS Games'],
): Promise<{ ok: boolean; patterns_written: number; errors: string[] }> {
  let written = 0;
  const errors: string[] = [];

  for (const company of companies) {
    try {
      const patterns = await learnCompanyPatterns(db, company);
      for (const p of patterns) {
        const { error } = await db.from('intel_memory').upsert({
          company: p.company,
          key: p.key,
          value: p.value,
          source: p.source,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'company,key' });
        if (error) errors.push(`${company}/${p.key}: ${error.message}`);
        else written++;
      }
    } catch (e: any) {
      errors.push(`${company}: ${e?.message ?? 'unknown'}`);
    }
  }

  console.log(`[MarketingMemory] cron done — ${written} patterns written, ${errors.length} errors`);
  return { ok: errors.length === 0, patterns_written: written, errors };
}

// ── Company pattern extractor ─────────────────────────────────────────────────

async function learnCompanyPatterns(
  db: SupabaseClient,
  company: string,
): Promise<MemoryPattern[]> {
  const patterns: MemoryPattern[] = [];

  // Fetch all published content for this company (last 180 days)
  const since180d = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const { data: content } = await db
    .from('intel_content')
    .select('platform, views, read_time_s, ctr, backlinks, signups, published_at, title, performance')
    .eq('company', company)
    .not('published_at', 'is', null)
    .gte('published_at', since180d)
    .order('published_at', { ascending: true });

  if (!content?.length) return patterns;

  // ── 1. Best platform by views ─────────────────────────────────────────────
  const byPlatform = groupBy(content, 'platform');
  const platformScores = Object.entries(byPlatform).map(([platform, items]) => ({
    platform,
    avg_views: avg(items.map((i: any) => (i.performance?.views ?? i.views ?? 0))),
    avg_signups: avg(items.map((i: any) => (i.performance?.signups ?? i.signups ?? 0))),
    count: items.length,
  }));
  platformScores.sort((a, b) => b.avg_views - a.avg_views);

  if (platformScores.length > 0) {
    patterns.push({
      company,
      key: 'best_platform_by_views',
      value: { platform: platformScores[0].platform, avg_views: platformScores[0].avg_views, count: platformScores[0].count, all: platformScores },
      source: 'cron',
    });
  }

  // Best platform by signups (often different from views)
  platformScores.sort((a, b) => b.avg_signups - a.avg_signups);
  if (platformScores.length > 0 && platformScores[0].avg_signups > 0) {
    patterns.push({
      company,
      key: 'best_platform_by_signups',
      value: { platform: platformScores[0].platform, avg_signups: platformScores[0].avg_signups },
      source: 'cron',
    });
  }

  // ── 2. Best day of week ───────────────────────────────────────────────────
  const dayGroups = groupByFn(
    content.filter((c: any) => c.published_at),
    (c: any) => new Date(c.published_at).toLocaleDateString('en-US', { weekday: 'long' }),
  );
  const dayScores = Object.entries(dayGroups).map(([day, items]) => ({
    day,
    avg_views: avg(items.map((i: any) => i.performance?.views ?? i.views ?? 0)),
    count: items.length,
  })).filter(d => d.count >= 2);

  dayScores.sort((a, b) => b.avg_views - a.avg_views);
  if (dayScores.length > 0) {
    patterns.push({
      company,
      key: 'best_day_of_week',
      value: { day: dayScores[0].day, avg_views: dayScores[0].avg_views, all: dayScores },
      source: 'cron',
    });
  }

  // ── 3. Best hour of day (UTC) ─────────────────────────────────────────────
  const hourGroups = groupByFn(
    content.filter((c: any) => c.published_at),
    (c: any) => String(new Date(c.published_at).getUTCHours()),
  );
  const hourScores = Object.entries(hourGroups).map(([hour, items]) => ({
    hour: Number(hour),
    avg_views: avg(items.map((i: any) => i.performance?.views ?? i.views ?? 0)),
    count: items.length,
  })).filter(h => h.count >= 2);

  hourScores.sort((a, b) => b.avg_views - a.avg_views);
  if (hourScores.length > 0) {
    patterns.push({
      company,
      key: 'best_hour_utc',
      value: { hour: hourScores[0].hour, avg_views: hourScores[0].avg_views },
      source: 'cron',
    });
  }

  // ── 4. Average article length that performs best ──────────────────────────
  // (proxied by read_time_s — 200 wpm → words = read_time_s / 60 * 200)
  const withReadTime = content.filter((c: any) => c.performance?.read_time_s > 0);
  if (withReadTime.length >= 3) {
    const sorted = [...withReadTime].sort(
      (a: any, b: any) => (b.performance?.views ?? 0) - (a.performance?.views ?? 0)
    );
    const top20pct = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.2)));
    const avgReadTimeSec = avg(top20pct.map((c: any) => c.performance?.read_time_s ?? 0));
    const estWords = Math.round((avgReadTimeSec / 60) * 200);
    patterns.push({
      company,
      key: 'best_article_length_words',
      value: { est_words: estWords, avg_read_time_s: Math.round(avgReadTimeSec) },
      source: 'cron',
    });
  }

  // ── 5. Read completed campaigns and extract channel learnings ─────────────
  const { data: campaigns } = await db
    .from('intel_campaigns')
    .select('name, channel_status, learnings, completed_at')
    .eq('company', company)
    .eq('status', 'complete')
    .not('learnings', 'is', null)
    .gte('completed_at', since180d);

  if (campaigns?.length) {
    const bestChannels = campaigns
      .map((c: any) => c.learnings?.best_channel)
      .filter(Boolean);
    if (bestChannels.length > 0) {
      const freq: Record<string, number> = {};
      for (const ch of bestChannels) freq[ch] = (freq[ch] ?? 0) + 1;
      const topChannel = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];
      patterns.push({
        company,
        key: 'best_campaign_channel',
        value: { channel: topChannel, frequency: freq, sample_campaigns: campaigns.length },
        source: 'cron',
      });
    }

    const totalViews = campaigns.reduce((s: number, c: any) => s + (c.learnings?.total_views ?? 0), 0);
    const totalSignups = campaigns.reduce((s: number, c: any) => s + (c.learnings?.total_signups ?? 0), 0);
    patterns.push({
      company,
      key: 'campaign_aggregate_180d',
      value: { total_views: totalViews, total_signups: totalSignups, campaigns: campaigns.length },
      source: 'cron',
    });
  }

  // ── 6. Content volume trend ───────────────────────────────────────────────
  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const since60d = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const last30 = content.filter((c: any) => c.published_at >= since30d).length;
  const prev30 = content.filter((c: any) => c.published_at >= since60d && c.published_at < since30d).length;
  patterns.push({
    company,
    key: 'content_volume_trend',
    value: {
      last_30d: last30,
      prev_30d: prev30,
      trend: prev30 === 0 ? 'new' : last30 > prev30 ? 'up' : last30 < prev30 ? 'down' : 'flat',
    },
    source: 'cron',
  });

  return patterns;
}

// ── SEO opportunity writer (called from GSC connector) ────────────────────────

/**
 * writeSeoOpportunity
 * Called by the Google Search Console connector adapter when it spots
 * a keyword trending up. Stores in intel_memory for /intel/context to surface.
 */
export async function writeSeoOpportunity(
  db: SupabaseClient,
  company: string,
  opportunity: {
    top_keyword: string;
    searches_up_pct: number;
    gsc_clicks_7d: number;
    gsc_impressions_7d: number;
  },
): Promise<{ ok: boolean }> {
  const { error } = await db.from('intel_memory').upsert({
    company,
    key: 'seo_opportunity',
    value: opportunity,
    source: 'cron',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'company,key' });
  return { ok: !error };
}

// ── Read memory (for /intel/context and Mission Control) ──────────────────────

/**
 * readMemory
 * Returns all patterns for a company, keyed by pattern key.
 * Mirrors graph.query() from CW1 memory/graph.js.
 */
export async function readMemory(
  db: SupabaseClient,
  company: string,
  keys?: string[],
): Promise<Record<string, unknown>> {
  let q = db.from('intel_memory').select('key, value, updated_at').eq('company', company);
  if (keys?.length) q = q.in('key', keys);
  const { data } = await q;
  if (!data) return {};
  return Object.fromEntries(data.map((r: any) => [r.key, r.value]));
}

// ── HTTP route ────────────────────────────────────────────────────────────────

/**
 * registerMarketingMemoryRoutes
 *
 * GET  /intel/memory/:company       → read all patterns for company
 * POST /intel/memory/run-cron       → trigger cron manually (internal only)
 * POST /intel/memory/seo-opportunity → write SEO opportunity (from connector)
 */
export function registerMarketingMemoryRoutes(app: any, db: SupabaseClient) {
  app.get('/intel/memory/:company', async (req: any, res: any) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthenticated' });
    const keys = req.query.keys ? (req.query.keys as string).split(',') : undefined;
    const mem = await readMemory(db, req.params.company, keys);
    res.json({ ok: true, company: req.params.company, patterns: mem });
  });

  // Internal cron trigger — require internal token
  app.post('/intel/memory/run-cron', async (req: any, res: any) => {
    const token = req.headers['x-internal-token'];
    if (!token || token !== process.env.INTERNAL_SERVICE_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const companies = req.body?.companies;
    const result = await runMarketingMemoryCron(db, companies);
    res.json(result);
  });

  app.post('/intel/memory/seo-opportunity', async (req: any, res: any) => {
    const token = req.headers['x-internal-token'];
    if (!token || token !== process.env.INTERNAL_SERVICE_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { company, opportunity } = req.body ?? {};
    if (!company || !opportunity) return res.status(400).json({ error: 'company + opportunity required' });
    const r = await writeSeoOpportunity(db, company, opportunity);
    res.json(r);
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = String(item[key] ?? 'unknown');
    (out[k] ??= []).push(item);
  }
  return out;
}

function groupByFn<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = fn(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}
