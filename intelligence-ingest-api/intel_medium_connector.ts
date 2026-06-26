// ============================================================================
// intel_medium_connector.ts · Intel v2 — Medium Publish Connector
// ============================================================================
// Lifecycle: Claude writes article → Intel queues it → DK approves → publishes
//            via Medium Integration API.
//
// POST_LIVE=0: scheduling/publishing is ALWAYS gated — this file never auto-
//              publishes without explicit DK approval flip.
//
// Reuses:
//   CW1/src/connectors/manifests/native.js  → connector manifest pattern
//   CW1/src/growth/scheduler.js             → POST_LIVE=0 dark scheduling gate
//   CW1/src/memory/graph.js                 → memory outcome pattern
//
// Medium Integration API docs:
//   https://github.com/Medium/medium-api-docs
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ArticleStatus =
  | 'draft'        // Claude wrote it, not yet submitted
  | 'pending'      // In approval queue, waiting for DK
  | 'approved'     // DK approved, ready to publish
  | 'rejected'     // DK rejected, needs revision
  | 'queued'       // Scheduled for a future time (POST_LIVE=0 gate holds)
  | 'published'    // Live on Medium
  | 'failed';      // Publish attempt failed

export interface MediumArticle {
  id: string;
  title: string;
  content_markdown: string;
  content_html?: string;
  tags: string[];
  canonical_url?: string;
  company: string;
  campaign_id?: string;
  author_cw: string;       // CW that wrote the article
  status: ArticleStatus;
  publish_status: 'public' | 'unlisted' | 'draft'; // Medium publish status
  scheduled_at?: string;   // ISO timestamp for scheduled publish (gate: POST_LIVE=0)
  published_at?: string;
  medium_url?: string;     // URL after successful publish
  medium_post_id?: string;
  approval_notes?: string; // DK's notes on approval/rejection
  word_count?: number;
  estimated_read_mins?: number;
  created_at: string;
  updated_at: string;
}

export interface MediumPublishResult {
  success: boolean;
  medium_post_id?: string;
  medium_url?: string;
  error?: string;
}

// ── Connector manifest (pattern from CW1/src/connectors/manifests/native.js) ──

export const MEDIUM_MANIFEST = {
  id: 'medium',
  name: 'Medium',
  description: 'Read/write connector for Medium publications. Publishes articles after DK approval. POST_LIVE=0 gate enforced.',
  version: '1.0.0',
  auth: {
    type: 'api_key' as const,
    env_var: 'MEDIUM_INTEGRATION_TOKEN',
    scopes: ['basicProfile', 'publishPost'],
  },
  capabilities: {
    read:  ['profile', 'publications', 'posts'],
    write: ['draft', 'publish'],     // write always requires POST_LIVE=1 gate
    webhooks: false,
    cron: false,                      // no polling needed for write-only
  },
  rate_limits: {
    requests_per_hour: 60,
    burst: 10,
  },
  // Dark flag: never auto-publishes even if token is present
  live_flag: 'POST_LIVE',
  live_flag_required_value: '1',
} as const;

// ── Medium API client ──────────────────────────────────────────────────────────

const MEDIUM_API_BASE = 'https://api.medium.com/v1';

interface MediumProfile {
  id: string;
  username: string;
  name: string;
  url: string;
  imageUrl: string;
}

async function getMediumProfile(token: string): Promise<MediumProfile> {
  const resp = await fetch(`${MEDIUM_API_BASE}/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!resp.ok) throw new Error(`Medium profile fetch failed: ${resp.status}`);
  const d = await resp.json();
  return d.data;
}

interface MediumPostPayload {
  title: string;
  contentFormat: 'markdown' | 'html';
  content: string;
  tags?: string[];
  canonicalUrl?: string;
  publishStatus: 'public' | 'unlisted' | 'draft';
  notifyFollowers?: boolean;
}

async function publishToMedium(
  token: string,
  authorId: string,
  payload: MediumPostPayload,
): Promise<{ id: string; url: string }> {
  const resp = await fetch(`${MEDIUM_API_BASE}/users/${authorId}/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Medium publish failed (${resp.status}): ${errText}`);
  }

  const d = await resp.json();
  return { id: d.data.id, url: d.data.url };
}

// ── POST_LIVE gate (pattern from CW1/src/growth/scheduler.js) ─────────────────

function isPostLive(): boolean {
  return (process.env.POST_LIVE ?? '0') === '1';
}

// ── Article management ─────────────────────────────────────────────────────────

export function createMediumConnector(db: SupabaseClient) {

  // Submit an article to the approval queue (CW calls this after writing)
  async function submitForApproval(article: Omit<MediumArticle, 'id' | 'status' | 'created_at' | 'updated_at'>): Promise<MediumArticle> {
    const wordCount = article.content_markdown.split(/\s+/).length;
    const readMins = Math.ceil(wordCount / 200);

    const { data, error } = await db
      .from('intel_content')
      .insert({
        ...article,
        status: 'pending',
        word_count: wordCount,
        estimated_read_mins: readMins,
        platform: 'medium',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(`submitForApproval: ${error.message}`);

    // Log to intel_memory so Marketing Memory learns (pattern from intel_marketing_memory.ts)
    await db.from('intel_memory').upsert({
      company: article.company,
      key: 'last_medium_draft',
      value: { title: article.title, submitted_at: new Date().toISOString(), author_cw: article.author_cw },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company,key' });

    return data as MediumArticle;
  }

  // DK approves an article (sets status to 'approved')
  async function approveArticle(articleId: string, notes?: string): Promise<MediumArticle> {
    const { data, error } = await db
      .from('intel_content')
      .update({
        status: 'approved',
        approval_notes: notes || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', articleId)
      .eq('platform', 'medium')
      .select()
      .single();

    if (error) throw new Error(`approveArticle: ${error.message}`);
    return data as MediumArticle;
  }

  // DK rejects an article (sends back to draft)
  async function rejectArticle(articleId: string, notes: string): Promise<MediumArticle> {
    const { data, error } = await db
      .from('intel_content')
      .update({
        status: 'rejected',
        approval_notes: notes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', articleId)
      .eq('platform', 'medium')
      .select()
      .single();

    if (error) throw new Error(`rejectArticle: ${error.message}`);
    return data as MediumArticle;
  }

  // Publish an approved article to Medium
  // Always checks POST_LIVE=1 before executing. If 0, queues only.
  async function publishArticle(articleId: string): Promise<MediumPublishResult> {
    // 1. Load article
    const { data: article, error: loadErr } = await db
      .from('intel_content')
      .select('*')
      .eq('id', articleId)
      .eq('platform', 'medium')
      .single();

    if (loadErr || !article) {
      return { success: false, error: `Article not found: ${articleId}` };
    }

    if (article.status !== 'approved') {
      return { success: false, error: `Article must be approved before publishing. Current status: ${article.status}` };
    }

    // 2. POST_LIVE gate (from CW1 dark scheduler pattern)
    if (!isPostLive()) {
      // Record intent only — never actually publishes
      await db.from('intel_content').update({
        status: 'queued',
        updated_at: new Date().toISOString(),
      }).eq('id', articleId);

      console.log(`[Medium] POST_LIVE=0 — publish of "${article.title}" queued only, NOT sent to Medium`);
      return { success: false, error: 'POST_LIVE=0: publish queued but not executed. Set POST_LIVE=1 to enable.' };
    }

    // 3. Get Medium token
    const token = process.env.MEDIUM_INTEGRATION_TOKEN;
    if (!token) {
      return { success: false, error: 'MEDIUM_INTEGRATION_TOKEN not set' };
    }

    try {
      // 4. Get author profile
      const profile = await getMediumProfile(token);

      // 5. Build payload
      const payload: MediumPostPayload = {
        title: article.title,
        contentFormat: 'markdown',
        content: article.content_markdown,
        tags: article.tags || [],
        canonicalUrl: article.canonical_url || undefined,
        publishStatus: article.publish_status || 'public',
        notifyFollowers: true,
      };

      // 6. Publish
      const result = await publishToMedium(token, profile.id, payload);

      // 7. Mark published
      await db.from('intel_content').update({
        status: 'published',
        medium_post_id: result.id,
        medium_url: result.url,
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', articleId);

      // 8. Write to Marketing Memory so it learns from this publish
      await db.from('intel_memory').upsert({
        company: article.company,
        key: 'last_medium_publish',
        value: {
          title: article.title,
          url: result.url,
          published_at: new Date().toISOString(),
          word_count: article.word_count,
          tags: article.tags,
        },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'company,key' });

      console.log(`[Medium] Published: "${article.title}" → ${result.url}`);
      return { success: true, medium_post_id: result.id, medium_url: result.url };

    } catch (err: any) {
      await db.from('intel_content').update({
        status: 'failed',
        updated_at: new Date().toISOString(),
      }).eq('id', articleId);

      return { success: false, error: err.message };
    }
  }

  // Get articles by status
  async function getArticles(company?: string, status?: ArticleStatus): Promise<MediumArticle[]> {
    let query = db
      .from('intel_content')
      .select('*')
      .eq('platform', 'medium')
      .order('created_at', { ascending: false });

    if (company) query = query.eq('company', company);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw new Error(`getArticles: ${error.message}`);
    return (data || []) as MediumArticle[];
  }

  // Get pending approval queue (called by Mission Control)
  async function getPendingApprovals(company?: string): Promise<MediumArticle[]> {
    return getArticles(company, 'pending');
  }

  // Claude-facing: write a new article draft
  // CW writes content, calls this, article goes to approval queue automatically
  async function cwWriteArticle(params: {
    title: string;
    content_markdown: string;
    tags: string[];
    company: string;
    campaign_id?: string;
    author_cw: string;
    canonical_url?: string;
    publish_status?: 'public' | 'unlisted' | 'draft';
  }): Promise<MediumArticle> {
    return submitForApproval({
      ...params,
      publish_status: params.publish_status || 'public',
    });
  }

  return {
    // CW-facing
    cwWriteArticle,
    // DK approval
    approveArticle,
    rejectArticle,
    publishArticle,
    // Read
    getArticles,
    getPendingApprovals,
    // Internal
    getMediumProfile,
  };
}

// ── HTTP route handlers ────────────────────────────────────────────────────────

export function registerMediumRoutes(app: any, db: SupabaseClient) {
  const connector = createMediumConnector(db);

  // GET /intel/medium/articles — list all articles
  // Query: ?company=TRD&status=pending
  app.get('/intel/medium/articles', async (req: any, res: any) => {
    try {
      const articles = await connector.getArticles(req.query.company, req.query.status);
      res.json({ articles, count: articles.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /intel/medium/approvals — pending approval queue (Mission Control uses this)
  app.get('/intel/medium/approvals', async (req: any, res: any) => {
    try {
      const pending = await connector.getPendingApprovals(req.query.company);
      res.json({ pending, count: pending.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /intel/medium/articles — CW submits new article
  // Body: { title, content_markdown, tags, company, campaign_id?, author_cw, canonical_url? }
  app.post('/intel/medium/articles', async (req: any, res: any) => {
    try {
      const article = await connector.cwWriteArticle(req.body);
      res.status(201).json({ article, message: 'Article submitted for approval' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // PATCH /intel/medium/articles/:id/approve — DK approves
  // Body: { notes? }
  app.patch('/intel/medium/articles/:id/approve', async (req: any, res: any) => {
    try {
      const article = await connector.approveArticle(req.params.id, req.body.notes);
      res.json({ article, message: 'Article approved. Call /publish to send to Medium.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // PATCH /intel/medium/articles/:id/reject — DK rejects
  // Body: { notes } (required — DK must explain why)
  app.patch('/intel/medium/articles/:id/reject', async (req: any, res: any) => {
    try {
      if (!req.body.notes) return res.status(400).json({ error: 'notes required for rejection' });
      const article = await connector.rejectArticle(req.params.id, req.body.notes);
      res.json({ article, message: 'Article rejected and returned to draft' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /intel/medium/articles/:id/publish — publish approved article
  // POST_LIVE=0: queues only, never actually publishes
  // POST_LIVE=1: sends to Medium API (DK must set this env var)
  app.post('/intel/medium/articles/:id/publish', async (req: any, res: any) => {
    try {
      const result = await connector.publishArticle(req.params.id);
      if (result.success) {
        res.json({ ...result, message: `Published to Medium: ${result.medium_url}` });
      } else {
        // Not a server error — could be POST_LIVE=0 gate or bad status
        res.status(200).json({ ...result, message: result.error });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /intel/medium/profile — verify token + show Medium profile
  app.get('/intel/medium/profile', async (req: any, res: any) => {
    try {
      const token = process.env.MEDIUM_INTEGRATION_TOKEN;
      if (!token) return res.status(400).json({ error: 'MEDIUM_INTEGRATION_TOKEN not set' });
      const profile = await connector.getMediumProfile(token);
      res.json({ profile, post_live: isPostLive() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[Intel] Medium connector routes registered');
}

// ── Env check (called on startup) ─────────────────────────────────────────────

export function mediumConnectorStatus(): {
  configured: boolean;
  post_live: boolean;
  missing_env: string[];
} {
  const missing: string[] = [];
  if (!process.env.MEDIUM_INTEGRATION_TOKEN) missing.push('MEDIUM_INTEGRATION_TOKEN');

  return {
    configured: missing.length === 0,
    post_live: isPostLive(),
    missing_env: missing,
  };
}
