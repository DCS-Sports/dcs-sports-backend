/**
 * intel_morning_brief.ts — Morning Brief generator
 * Runs daily at 6am UTC. Reads all OS modules. Writes to intel_morning_brief table.
 * Also generates the structured Claude prompt for the day.
 *
 * Source: CW4/src/analytics/ledger-aggregator.js (getCostTrends, getOverviewMetrics patterns)
 * Schedule: Railway cron or node-cron inside intelligence-ingest-api
 * Security: read-only · no money · no autonomy · AUTONOMY_LIVE=0
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { buildIntelContext } from './intel_context_api';
import { readMemory, runMarketingMemoryCron } from './intel_marketing_memory';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MorningBrief {
  id: string;
  user_id: string;
  date: string;                   // YYYY-MM-DD UTC
  metrics: BriefMetrics;
  top_items: BriefItem[];         // mission control items, sorted by priority
  recommendation: string | null;  // one key action for the day
  claude_prompt: string;          // paste into Claude to start the day
  generated_at: string;
}

export interface BriefMetrics {
  visitors_7d: number;
  visitors_trend: string;
  signups_7d: number;
  active_runs: number;
  today_cost_usd: string;
  top_campaign: string | null;
  top_campaign_pct: number | null;
  agents_waiting_review: number;
  blocked_tasks: number;
  top_platform: string | null;
  best_day_today: boolean;      // is today the best publishing day from Marketing Memory?
}

export interface BriefItem {
  priority: number;               // 1 = highest
  category: 'marketing' | 'engineering' | 'business' | 'agents';
  action: string;
  cw: string | null;
  urgent: boolean;
}

// ── Main generator ────────────────────────────────────────────────────────────

/**
 * generateMorningBrief
 * Aggregates all OS modules into one structured brief.
 * Adapted from CW4 getDashboardData — but cross-joins campaigns, agents, memory.
 */
export async function generateMorningBrief(
  db: SupabaseClient,
  userId: string,
  company = 'DCS AI',
): Promise<{ ok: boolean; brief?: MorningBrief; error?: string }> {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Check if brief already generated today
    const { data: existing } = await db
      .from('intel_morning_brief')
      .select('id')
      .eq('user_id', userId)
      .gte('generated_at', `${today}T00:00:00Z`)
      .maybeSingle();

    if (existing) {
      return { ok: true, error: 'already_generated_today' };
    }

    // Pull context + memory in parallel
    const [ctx, memory] = await Promise.all([
      buildIntelContext(db, userId, { company }),
      readMemory(db, company, ['best_day_of_week', 'best_platform_by_views', 'seo_opportunity', 'best_campaign_channel']),
    ]);

    // Is today the best publishing day?
    const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const bestDay = (memory['best_day_of_week'] as any)?.day ?? null;
    const bestDayToday = bestDay === todayName;

    const metrics: BriefMetrics = {
      visitors_7d: ctx.analytics.visitors_7d,
      visitors_trend: ctx.analytics.visitors_trend,
      signups_7d: ctx.analytics.signups_7d,
      active_runs: ctx.analytics.active_runs,
      today_cost_usd: ctx.analytics.today_cost_usd,
      top_campaign: ctx.campaign?.name ?? null,
      top_campaign_pct: ctx.campaign?.pct_complete ?? null,
      agents_waiting_review: ctx.agents.waiting_review,
      blocked_tasks: ctx.today_tasks.filter(t => t.blocker).length,
      top_platform: (memory['best_platform_by_views'] as any)?.platform ?? ctx.social.top_platform,
      best_day_today: bestDayToday,
    };

    // Build top items
    const items: BriefItem[] = [];

    // 1. Blocked tasks (urgent)
    for (const t of ctx.today_tasks.filter(t => t.blocker)) {
      items.push({
        priority: 1,
        category: 'agents',
        action: `Unblock: ${t.title} (waiting ${t.hours_waiting}hrs)`,
        cw: t.assigned_cw,
        urgent: true,
      });
    }

    // 2. Approvals waiting > 12hrs
    for (const a of ctx.pending_approvals.filter(a => a.hours_waiting > 12)) {
      items.push({
        priority: 2,
        category: 'marketing',
        action: `Review & approve: ${a.label} (${a.hours_waiting}hrs waiting)`,
        cw: a.cw,
        urgent: true,
      });
    }

    // 3. Campaign pending channels (if today is best day)
    if (ctx.campaign && bestDayToday && ctx.campaign.pending_channels.length > 0) {
      items.push({
        priority: 3,
        category: 'marketing',
        action: `Publish campaign "${ctx.campaign.name}" on ${ctx.campaign.pending_channels.slice(0, 3).join(', ')} — today is ${bestDay} (your best day)`,
        cw: null,
        urgent: false,
      });
    }

    // 4. SEO opportunity
    const seoOpp = memory['seo_opportunity'] as any;
    if (seoOpp?.top_keyword) {
      items.push({
        priority: 4,
        category: 'marketing',
        action: `SEO opportunity: "${seoOpp.top_keyword}" — searches up ${seoOpp.searches_up_pct}%. Write article.`,
        cw: null,
        urgent: false,
      });
    }

    // 5. Agents waiting review (non-urgent)
    if (ctx.agents.waiting_review > 0) {
      items.push({
        priority: 5,
        category: 'agents',
        action: `${ctx.agents.waiting_review} AI coworker output(s) waiting your review`,
        cw: null,
        urgent: false,
      });
    }

    // Sort by priority
    items.sort((a, b) => a.priority - b.priority);

    // Build recommendation
    const recommendation = ctx.recommendation
      ?? (seoOpp?.top_keyword
        ? `Write about "${seoOpp.top_keyword}" today — searches up ${seoOpp.searches_up_pct}%.`
        : bestDayToday
        ? `Today is ${bestDay} — your best publishing day. Push at least one piece of content.`
        : null);

    // Build the Claude prompt for the day
    const claudePrompt = buildClaudePrompt(ctx, memory, metrics, items, recommendation);

    const brief: MorningBrief = {
      id: randomUUID(),
      user_id: userId,
      date: today,
      metrics,
      top_items: items,
      recommendation,
      claude_prompt: claudePrompt,
      generated_at: new Date().toISOString(),
    };

    // Persist
    await db.from('intel_morning_brief').insert({
      id: brief.id,
      user_id: userId,
      metrics: brief.metrics,
      recommendation: brief.recommendation,
      claude_prompt: brief.claude_prompt,
      generated_at: brief.generated_at,
    });

    return { ok: true, brief };
  } catch (e: any) {
    console.error('[MorningBrief] generation error', e?.message);
    return { ok: false, error: e?.message ?? 'unknown' };
  }
}

// ── Claude prompt builder ─────────────────────────────────────────────────────

function buildClaudePrompt(
  ctx: Awaited<ReturnType<typeof buildIntelContext>>,
  memory: Record<string, unknown>,
  metrics: BriefMetrics,
  items: BriefItem[],
  recommendation: string | null,
): string {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const bestPlatform = (memory['best_platform_by_views'] as any)?.platform ?? 'unknown';
  const bestDay = (memory['best_day_of_week'] as any)?.day ?? 'unknown';
  const topItems = items.slice(0, 5).map((i, n) => `${n + 1}. [${i.category.toUpperCase()}] ${i.action}`).join('\n');

  return `
# DCS Intel Daily Brief — ${today}

## Company Pulse
- Traffic (7d): ${metrics.visitors_7d.toLocaleString()} visitors (${metrics.visitors_trend})
- Signups (7d): ${metrics.signups_7d}
- Active AI coworkers: ${metrics.active_runs}
- Cost today: $${metrics.today_cost_usd}
- Campaign: ${metrics.top_campaign ?? 'none active'} (${metrics.top_campaign_pct ?? 0}% complete)
- Agents waiting review: ${metrics.agents_waiting_review}
- Best publishing platform: ${bestPlatform}
- Best publishing day: ${bestDay} (today is ${metrics.best_day_today ? '✓ TODAY' : 'not today'})

## Priority Actions Today
${topItems || 'Nothing urgent — great day to create content.'}

## Recommendation
${recommendation ?? 'No specific recommendation — check Intel for opportunities.'}

## Your Task
Based on the above Intel brief, please:
1. Review the priority actions and tell me which to tackle first and why
2. Identify any content I should publish today given the platform and day patterns
3. Flag any risks or blockers I should know about
4. Suggest one campaign or content piece that would perform best today
5. Draft an outline for the highest-priority content piece if one exists

Remember: You have access to GET /intel/context for live data. All posting stays dark until I approve.
`.trim();
}

// ── Cron scheduler ────────────────────────────────────────────────────────────

/**
 * startMorningBriefCron
 * Call once at service startup. Runs at 6am UTC daily.
 * Also runs Marketing Memory cron at 3am UTC.
 *
 * Uses node-cron if available; falls back to setInterval.
 */
export async function startMorningBriefCron(
  db: SupabaseClient,
  getUserIds: () => Promise<string[]>,
) {
  let cron: any = null;
  try { cron = await import('node-cron'); } catch {}

  const runBriefs = async () => {
    console.log('[MorningBrief] generating briefs...');
    const userIds = await getUserIds();
    const results = await Promise.allSettled(
      userIds.map(id => generateMorningBrief(db, id))
    );
    const done = results.filter(r => r.status === 'fulfilled').length;
    console.log(`[MorningBrief] generated ${done}/${userIds.length} briefs`);
  };

  const runMemory = async () => {
    console.log('[MarketingMemory] cron starting...');
    await runMarketingMemoryCron(db);
  };

  if (cron?.schedule) {
    cron.schedule('0 3 * * *', runMemory, { timezone: 'UTC' }); // 3am
    cron.schedule('0 6 * * *', runBriefs, { timezone: 'UTC' }); // 6am
    console.log('[Intel] Crons scheduled: Memory@3am, Briefs@6am UTC');
  } else {
    // Fallback: 24hr interval from now
    setTimeout(runMemory, 0);
    setInterval(runMemory, 24 * 60 * 60 * 1000);
    setInterval(runBriefs, 24 * 60 * 60 * 1000);
    console.log('[Intel] Fallback interval crons started (no node-cron)');
  }
}

// ── HTTP routes ───────────────────────────────────────────────────────────────

/**
 * registerMorningBriefRoutes
 *
 * GET  /intel/brief/today      → latest brief for today (generate if missing)
 * GET  /intel/brief/history    → last 30 briefs
 * POST /intel/brief/generate   → force regenerate (DK only)
 */
export function registerMorningBriefRoutes(app: any, db: SupabaseClient) {
  app.get('/intel/brief/today', async (req: any, res: any) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const today = new Date().toISOString().split('T')[0];
    const { data: existing } = await db
      .from('intel_morning_brief')
      .select('*')
      .eq('user_id', userId)
      .gte('generated_at', `${today}T00:00:00Z`)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) return res.json({ ok: true, brief: existing });

    // Generate on demand
    const company = req.query.company as string ?? 'DCS AI';
    const result = await generateMorningBrief(db, userId, company);
    res.json(result);
  });

  app.get('/intel/brief/history', async (req: any, res: any) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    const { data } = await db
      .from('intel_morning_brief')
      .select('id, generated_at, recommendation, metrics')
      .eq('user_id', userId)
      .order('generated_at', { ascending: false })
      .limit(30);
    res.json({ ok: true, briefs: data ?? [] });
  });

  app.post('/intel/brief/generate', async (req: any, res: any) => {
    const token = req.headers['x-internal-token'];
    if (!token || token !== process.env.INTERNAL_SERVICE_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const userId = req.user?.id ?? req.body?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const company = req.body?.company ?? 'DCS AI';
    const result = await generateMorningBrief(db, userId, company);
    res.json(result);
  });
}
