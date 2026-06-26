/**
 * intel_social_connectors.ts — Social platform adapters for Intel v2
 * LinkedIn · X (Twitter) · YouTube · Medium · Reddit · Discord · Product Hunt
 *
 * Source: CW1/src/connectors/manifest.js (validateManifest, createManifestRegistry)
 *         CW1/src/connectors/manifests/native.js (LinkedIn, Discord manifests as base)
 *
 * Pattern: each adapter fetches → normalises → upserts into intel_social_snapshots
 * Schedule: run hourly via startSocialSyncCron()
 * Security: tokens via env only · POST_LIVE=0 · no posting · read-only
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SocialPlatform =
  | 'linkedin' | 'x' | 'youtube' | 'medium'
  | 'reddit' | 'discord' | 'product_hunt' | 'hashnode' | 'devto';

export interface SocialSnapshot {
  id: string;
  company: string;
  platform: SocialPlatform;
  followers: number | null;
  impressions_7d: number | null;
  posts_7d: number | null;
  top_post_title: string | null;
  top_post_url: string | null;
  top_post_views: number | null;
  engagement_rate: number | null;  // 0.0–1.0
  snapped_at: string;
  raw: Record<string, unknown>;    // full platform response for debugging
}

export interface ConnectorResult {
  ok: boolean;
  platform: SocialPlatform;
  company: string;
  snapshot?: SocialSnapshot;
  error?: string;
  skipped?: boolean;   // true if env token not set
}

// ── Connector registry (extends CW1 createManifestRegistry pattern) ───────────

const SOCIAL_MANIFESTS = {
  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn',
    auth: 'oauth2',
    baseUrl: 'https://api.linkedin.com/v2',
    scopes: ['r_organization_social', 'r_liteprofile'],
    envToken: 'LINKEDIN_ACCESS_TOKEN',
    orgEnv: 'LINKEDIN_ORG_ID',
  },
  x: {
    id: 'x',
    name: 'X (Twitter)',
    auth: 'bearer',
    baseUrl: 'https://api.twitter.com/2',
    envToken: 'X_BEARER_TOKEN',
    userEnv: 'X_USERNAME',
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    auth: 'api_key',
    baseUrl: 'https://www.googleapis.com/youtube/v3',
    envToken: 'YOUTUBE_API_KEY',
    channelEnv: 'YOUTUBE_CHANNEL_ID',
  },
  medium: {
    id: 'medium',
    name: 'Medium',
    auth: 'api_key',
    baseUrl: 'https://api.medium.com/v1',
    envToken: 'MEDIUM_ACCESS_TOKEN',
  },
  reddit: {
    id: 'reddit',
    name: 'Reddit',
    auth: 'oauth2',
    baseUrl: 'https://oauth.reddit.com',
    envToken: 'REDDIT_ACCESS_TOKEN',
    subredditEnv: 'REDDIT_SUBREDDIT',
  },
  discord: {
    id: 'discord',
    name: 'Discord',
    auth: 'bot',
    baseUrl: 'https://discord.com/api/v10',
    envToken: 'DISCORD_BOT_TOKEN_TRD',
    serverEnv: 'DISCORD_SERVER_ID',
  },
  product_hunt: {
    id: 'product_hunt',
    name: 'Product Hunt',
    auth: 'api_key',
    baseUrl: 'https://api.producthunt.com/v2/api/graphql',
    envToken: 'PRODUCT_HUNT_API_TOKEN',
  },
  hashnode: {
    id: 'hashnode',
    name: 'Hashnode',
    auth: 'api_key',
    baseUrl: 'https://gql.hashnode.com',
    envToken: 'HASHNODE_ACCESS_TOKEN',
    pubEnv: 'HASHNODE_PUBLICATION_ID',
  },
  devto: {
    id: 'devto',
    name: 'Dev.to',
    auth: 'api_key',
    baseUrl: 'https://dev.to/api',
    envToken: 'DEVTO_API_KEY',
  },
} as const;

// ── Individual adapters ───────────────────────────────────────────────────────

/**
 * fetchLinkedIn — org follower count + recent post impressions
 * Reuses CW1 native.js LinkedIn manifest (id: 'linkedin', auth: 'oauth2')
 */
async function fetchLinkedIn(company: string): Promise<Omit<SocialSnapshot, 'id' | 'snapped_at'>> {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const orgId = process.env.LINKEDIN_ORG_ID;

  if (!token || !orgId) throw new Error('LINKEDIN_ACCESS_TOKEN or LINKEDIN_ORG_ID not set');

  const headers = { Authorization: `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' };

  // Follower count
  const followerResp = await fetch(
    `https://api.linkedin.com/v2/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=urn:li:organization:${orgId}`,
    { headers }
  );
  const followerData = followerResp.ok ? await followerResp.json() : null;
  const followers = followerData?.elements?.[0]?.totalFollowerCounts?.organicFollowerCount ?? null;

  // Recent post stats (last 7d)
  const since = Date.now() - 7 * 86_400_000;
  const statsResp = await fetch(
    `https://api.linkedin.com/v2/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn:li:organization:${orgId}&timeIntervals.timeRange.start=${since}`,
    { headers }
  );
  const statsData = statsResp.ok ? await statsResp.json() : null;
  const totalImpressions = statsData?.elements?.reduce(
    (s: number, e: any) => s + (e.totalShareStatistics?.impressionCount ?? 0), 0
  ) ?? null;

  const topPost = statsData?.elements?.sort(
    (a: any, b: any) => (b.totalShareStatistics?.impressionCount ?? 0) - (a.totalShareStatistics?.impressionCount ?? 0)
  )?.[0];

  return {
    company,
    platform: 'linkedin',
    followers,
    impressions_7d: totalImpressions,
    posts_7d: statsData?.elements?.length ?? null,
    top_post_title: null,  // LinkedIn API doesn't return title in stats endpoint
    top_post_url: topPost?.share ? `https://www.linkedin.com/feed/update/${topPost.share}` : null,
    top_post_views: topPost?.totalShareStatistics?.impressionCount ?? null,
    engagement_rate: totalImpressions && followers
      ? Number(((topPost?.totalShareStatistics?.clickCount ?? 0) / followers).toFixed(4))
      : null,
    raw: { followerData, statsData },
  };
}

/**
 * fetchX — profile metrics + recent tweet impressions via API v2
 * Token: BEARER (no OAuth needed for read)
 */
async function fetchX(company: string): Promise<Omit<SocialSnapshot, 'id' | 'snapped_at'>> {
  const token = process.env.X_BEARER_TOKEN;
  const username = process.env.X_USERNAME;
  if (!token || !username) throw new Error('X_BEARER_TOKEN or X_USERNAME not set');

  const headers = { Authorization: `Bearer ${token}` };

  // User lookup
  const userResp = await fetch(
    `https://api.twitter.com/2/users/by/username/${username}?user.fields=public_metrics`,
    { headers }
  );
  const userData = userResp.ok ? await userResp.json() : null;
  const metrics = userData?.data?.public_metrics;

  // Recent tweets (last 7d)
  const userId = userData?.data?.id;
  let topTweet = null;
  let impressions7d = null;

  if (userId) {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const tweetsResp = await fetch(
      `https://api.twitter.com/2/users/${userId}/tweets?max_results=10&tweet.fields=public_metrics,created_at&start_time=${since}`,
      { headers }
    );
    const tweetsData = tweetsResp.ok ? await tweetsResp.json() : null;
    const tweets = tweetsData?.data ?? [];
    impressions7d = tweets.reduce(
      (s: number, t: any) => s + (t.public_metrics?.impression_count ?? 0), 0
    );
    topTweet = tweets.sort(
      (a: any, b: any) => (b.public_metrics?.impression_count ?? 0) - (a.public_metrics?.impression_count ?? 0)
    )[0] ?? null;
  }

  return {
    company,
    platform: 'x',
    followers: metrics?.followers_count ?? null,
    impressions_7d: impressions7d,
    posts_7d: null,
    top_post_title: topTweet?.text?.slice(0, 100) ?? null,
    top_post_url: topTweet?.id ? `https://x.com/${username}/status/${topTweet.id}` : null,
    top_post_views: topTweet?.public_metrics?.impression_count ?? null,
    engagement_rate: metrics?.followers_count && topTweet?.public_metrics?.like_count
      ? Number((topTweet.public_metrics.like_count / metrics.followers_count).toFixed(4))
      : null,
    raw: { userData },
  };
}

/**
 * fetchYouTube — channel stats + top video (already live in v1 — this normalises it)
 * Token: API key (same as existing YOUTUBE_API_KEY in v1)
 */
async function fetchYouTube(company: string): Promise<Omit<SocialSnapshot, 'id' | 'snapped_at'>> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const channelId = process.env.YOUTUBE_CHANNEL_ID;
  if (!apiKey || !channelId) throw new Error('YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID not set');

  const [channelResp, videosResp] = await Promise.all([
    fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${apiKey}`),
    fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=viewCount&type=video&maxResults=5&key=${apiKey}`),
  ]);

  const channelData = channelResp.ok ? await channelResp.json() : null;
  const videosData = videosResp.ok ? await videosResp.json() : null;
  const stats = channelData?.items?.[0]?.statistics;
  const topVideo = videosData?.items?.[0];

  return {
    company,
    platform: 'youtube',
    followers: stats?.subscriberCount ? Number(stats.subscriberCount) : null,
    impressions_7d: stats?.viewCount ? Number(stats.viewCount) : null,  // total views (no 7d filter in free tier)
    posts_7d: null,
    top_post_title: topVideo?.snippet?.title ?? null,
    top_post_url: topVideo?.id?.videoId ? `https://www.youtube.com/watch?v=${topVideo.id.videoId}` : null,
    top_post_views: null,
    engagement_rate: null,
    raw: { channelData },
  };
}

/**
 * fetchMedium — follower count + recent post stats
 * Uses unofficial stats endpoint (authenticated)
 */
async function fetchMedium(company: string): Promise<Omit<SocialSnapshot, 'id' | 'snapped_at'>> {
  const token = process.env.MEDIUM_ACCESS_TOKEN;
  if (!token) throw new Error('MEDIUM_ACCESS_TOKEN not set');

  const userResp = await fetch('https://api.medium.com/v1/me', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const userData = userResp.ok ? await userResp.json() : null;
  const username = userData?.data?.username;

  // Medium public stats (profile page)
  let followers = null;
  if (username) {
    // Medium's stats API requires partner program — use public endpoint
    const pubResp = await fetch(`https://medium.com/@${username}?format=json`);
    if (pubResp.ok) {
      const text = await pubResp.text();
      const match = text.match(/"socialStats":\{"userId":"[^"]+","usersFollowedByCount":(\d+)/);
      if (match) followers = Number(match[1]);
    }
  }

  return {
    company,
    platform: 'medium',
    followers,
    impressions_7d: null,   // Medium Partner Program only
    posts_7d: null,
    top_post_title: null,
    top_post_url: username ? `https://medium.com/@${username}` : null,
    top_post_views: null,
    engagement_rate: null,
    raw: { userData },
  };
}

/**
 * fetchDiscord — member count via bot
 * Reuses CW1 native.js Discord manifest (id: 'discord', auth: 'oauth2', baseUrl: discord.com/api/v10)
 */
async function fetchDiscord(company: string): Promise<Omit<SocialSnapshot, 'id' | 'snapped_at'>> {
  const token = process.env.DISCORD_BOT_TOKEN_TRD;
  const serverId = process.env.DISCORD_SERVER_ID;
  if (!token || !serverId) throw new Error('DISCORD_BOT_TOKEN_TRD or DISCORD_SERVER_ID not set');

  const resp = await fetch(`https://discord.com/api/v10/guilds/${serverId}?with_counts=true`, {
    headers: { Authorization: `Bot ${token}` },
  });
  const data = resp.ok ? await resp.json() : null;

  return {
    company,
    platform: 'discord',
    followers: data?.approximate_member_count ?? null,
    impressions_7d: null,
    posts_7d: null,
    top_post_title: null,
    top_post_url: data?.vanity_url_code ? `https://discord.gg/${data.vanity_url_code}` : null,
    top_post_views: null,
    engagement_rate: data?.approximate_presence_count && data?.approximate_member_count
      ? Number((data.approximate_presence_count / data.approximate_member_count).toFixed(4))
      : null,
    raw: { data },
  };
}

/**
 * fetchHashnode — publication follower count + top posts
 */
async function fetchHashnode(company: string): Promise<Omit<SocialSnapshot, 'id' | 'snapped_at'>> {
  const token = process.env.HASHNODE_ACCESS_TOKEN;
  const pubId = process.env.HASHNODE_PUBLICATION_ID;
  if (!token || !pubId) throw new Error('HASHNODE_ACCESS_TOKEN or HASHNODE_PUBLICATION_ID not set');

  const query = `query {
    publication(id: "${pubId}") {
      followersCount
      posts(first: 5) { edges { node { title url views reactionCount } } }
    }
  }`;

  const resp = await fetch('https://gql.hashnode.com', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = resp.ok ? await resp.json() : null;
  const pub = data?.data?.publication;
  const posts = pub?.posts?.edges?.map((e: any) => e.node) ?? [];
  const topPost = posts.sort((a: any, b: any) => (b.views ?? 0) - (a.views ?? 0))[0] ?? null;

  return {
    company,
    platform: 'hashnode',
    followers: pub?.followersCount ?? null,
    impressions_7d: posts.reduce((s: number, p: any) => s + (p.views ?? 0), 0) || null,
    posts_7d: null,
    top_post_title: topPost?.title ?? null,
    top_post_url: topPost?.url ?? null,
    top_post_views: topPost?.views ?? null,
    engagement_rate: null,
    raw: { data },
  };
}

/**
 * fetchDevTo — follower count + top articles
 */
async function fetchDevTo(company: string): Promise<Omit<SocialSnapshot, 'id' | 'snapped_at'>> {
  const apiKey = process.env.DEVTO_API_KEY;
  if (!apiKey) throw new Error('DEVTO_API_KEY not set');

  const [userResp, articlesResp] = await Promise.all([
    fetch('https://dev.to/api/users/me', { headers: { 'api-key': apiKey } }),
    fetch('https://dev.to/api/articles/me?per_page=10', { headers: { 'api-key': apiKey } }),
  ]);

  const userData = userResp.ok ? await userResp.json() : null;
  const articles = articlesResp.ok ? await articlesResp.json() : [];
  const topArticle = [...articles].sort((a: any, b: any) => (b.page_views_count ?? 0) - (a.page_views_count ?? 0))[0] ?? null;
  const impressions7d = articles.reduce((s: number, a: any) => s + (a.page_views_count ?? 0), 0);

  return {
    company,
    platform: 'devto',
    followers: userData?.followers_count ?? null,
    impressions_7d: impressions7d || null,
    posts_7d: articles.filter((a: any) => {
      const pub = new Date(a.published_at).getTime();
      return pub > Date.now() - 7 * 86_400_000;
    }).length || null,
    top_post_title: topArticle?.title ?? null,
    top_post_url: topArticle?.url ?? null,
    top_post_views: topArticle?.page_views_count ?? null,
    engagement_rate: null,
    raw: { userData },
  };
}

// ── Dispatch table ────────────────────────────────────────────────────────────

const FETCHERS: Partial<Record<SocialPlatform, (company: string) => Promise<Omit<SocialSnapshot, 'id' | 'snapped_at'>>>> = {
  linkedin: fetchLinkedIn,
  x: fetchX,
  youtube: fetchYouTube,
  medium: fetchMedium,
  discord: fetchDiscord,
  hashnode: fetchHashnode,
  devto: fetchDevTo,
};

// ── Main sync function ────────────────────────────────────────────────────────

/**
 * syncSocialPlatform
 * Fetches one platform, upserts into intel_social_snapshots.
 * Fails gracefully — Intel never crashes because one platform is down.
 */
export async function syncSocialPlatform(
  db: SupabaseClient,
  platform: SocialPlatform,
  company: string,
): Promise<ConnectorResult> {
  const fetcher = FETCHERS[platform];
  if (!fetcher) return { ok: false, platform, company, error: 'no_fetcher' };

  // Check token exists before attempting
  const manifest = SOCIAL_MANIFESTS[platform];
  const tokenKey = (manifest as any)?.envToken;
  if (tokenKey && !process.env[tokenKey]) {
    return { ok: true, platform, company, skipped: true };
  }

  try {
    const snap = await fetcher(company);
    const row: SocialSnapshot = {
      id: randomUUID(),
      ...snap,
      snapped_at: new Date().toISOString(),
    };

    const { error } = await db.from('intel_social_snapshots').insert({
      id: row.id,
      company: row.company,
      platform: row.platform,
      followers: row.followers,
      impressions_7d: row.impressions_7d,
      top_post: row.top_post_title,
      snapped_at: row.snapped_at,
    });

    if (error) {
      console.error(`[Social:${platform}] db error`, error.message);
      return { ok: false, platform, company, error: error.message };
    }

    return { ok: true, platform, company, snapshot: row };
  } catch (e: any) {
    console.error(`[Social:${platform}] fetch error`, e?.message);
    return { ok: false, platform, company, error: e?.message ?? 'unknown' };
  }
}

/**
 * syncAllSocial
 * Run all connected platforms for all companies.
 * Skips platforms whose tokens aren't set (fail-open).
 */
export async function syncAllSocial(
  db: SupabaseClient,
  platforms: SocialPlatform[] = ['linkedin', 'x', 'youtube', 'medium', 'discord', 'hashnode', 'devto'],
  companies: string[] = ['TRD', 'DCS AI', 'DCS Labs', 'DCS Rank'],
): Promise<{ results: ConnectorResult[]; synced: number; skipped: number; errors: number }> {
  const tasks: Promise<ConnectorResult>[] = [];
  for (const company of companies) {
    for (const platform of platforms) {
      tasks.push(syncSocialPlatform(db, platform, company));
    }
  }

  const results = await Promise.allSettled(tasks).then(r =>
    r.map(p => p.status === 'fulfilled' ? p.value : { ok: false, platform: 'unknown' as SocialPlatform, company: 'unknown', error: 'promise_rejected' })
  );

  return {
    results,
    synced: results.filter(r => r.ok && !r.skipped).length,
    skipped: results.filter(r => r.skipped).length,
    errors: results.filter(r => !r.ok && !r.skipped).length,
  };
}

// ── Latest snapshot reader ────────────────────────────────────────────────────

/**
 * getLatestSocialSnapshots
 * Returns most recent snapshot per platform per company.
 * Used by /intel/context and the Social OS tab.
 */
export async function getLatestSocialSnapshots(
  db: SupabaseClient,
  company?: string,
): Promise<SocialSnapshot[]> {
  let q = db
    .from('intel_social_snapshots')
    .select('*')
    .order('snapped_at', { ascending: false });

  if (company) q = q.eq('company', company);

  const { data } = await q.limit(200);
  if (!data) return [];

  // Dedupe: keep latest per (company, platform)
  const seen = new Set<string>();
  return data.filter((row: any) => {
    const key = `${row.company}:${row.platform}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }) as unknown as SocialSnapshot[];
}

// ── Cron scheduler ────────────────────────────────────────────────────────────

export async function startSocialSyncCron(db: SupabaseClient) {
  let cron: any = null;
  try { cron = await import('node-cron'); } catch {}

  const run = () => syncAllSocial(db).then(r =>
    console.log(`[SocialSync] done — synced:${r.synced} skipped:${r.skipped} errors:${r.errors}`)
  );

  if (cron?.schedule) {
    cron.schedule('0 * * * *', run); // every hour
    console.log('[Intel] Social sync cron: every hour');
  } else {
    run();
    setInterval(run, 60 * 60 * 1000);
  }
}

// ── HTTP routes ───────────────────────────────────────────────────────────────

/**
 * registerSocialConnectorRoutes
 *
 * GET  /intel/social                    → latest snapshots for all platforms
 * GET  /intel/social/:platform          → latest for one platform
 * POST /intel/social/sync               → trigger sync (internal)
 * POST /intel/social/sync/:platform     → sync one platform (internal)
 */
export function registerSocialConnectorRoutes(app: any, db: SupabaseClient) {
  app.get('/intel/social', async (req: any, res: any) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthenticated' });
    const snapshots = await getLatestSocialSnapshots(db, req.query.company);
    res.json({ ok: true, snapshots });
  });

  app.get('/intel/social/:platform', async (req: any, res: any) => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthenticated' });
    const { data } = await db
      .from('intel_social_snapshots')
      .select('*')
      .eq('platform', req.params.platform)
      .order('snapped_at', { ascending: false })
      .limit(30);
    res.json({ ok: true, platform: req.params.platform, history: data ?? [] });
  });

  const internalAuth = (req: any, res: any) => {
    if (req.headers['x-internal-token'] !== process.env.INTERNAL_SERVICE_TOKEN) {
      res.status(401).json({ error: 'unauthorized' }); return false;
    }
    return true;
  };

  app.post('/intel/social/sync', async (req: any, res: any) => {
    if (!internalAuth(req, res)) return;
    const { platforms, companies } = req.body ?? {};
    const result = await syncAllSocial(db, platforms, companies);
    res.json(result);
  });

  app.post('/intel/social/sync/:platform', async (req: any, res: any) => {
    if (!internalAuth(req, res)) return;
    const company = req.body?.company ?? 'DCS AI';
    const result = await syncSocialPlatform(db, req.params.platform as SocialPlatform, company);
    res.json(result);
  });
}
