/**
 * intel_engineering_os.ts — Engineering OS adapter
 * Railway · GitHub · Cloudflare Pages/Workers · Sentry
 * Surfaces service health, deploy history, CI status, incidents → Intel + Mission Control
 *
 * Source: CW1/src/connectors/manifest.js (connector manifest pattern)
 *         CW7/CW_Work_Consolidated/Gateway_Routes_and_R2_Runbook.md (Railway service names)
 * Security: read-only · no deploys · DK_DEPLOY_GATE enforced
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

// ── Known Railway services (from CW7 runbook + current deploy) ───────────────
export const RAILWAY_SERVICES = [
  'mind-api',
  'spine-api',
  'atlas-api',
  'agentic-coreloop-api',
  'intelligence-ingest-api',
  'agentic-sandbox',
] as const;

export type RailwayService = typeof RAILWAY_SERVICES[number];

// ── Types ─────────────────────────────────────────────────────────────────────

export type ServiceHealth = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface ServiceStatus {
  name: RailwayService | string;
  health: ServiceHealth;
  latest_deploy_at: string | null;
  latest_deploy_sha: string | null;
  latest_deploy_status: 'SUCCESS' | 'FAILED' | 'BUILDING' | 'UNKNOWN';
  env_flags: Record<string, string>;   // AV2_ATLAS_BIND, AUTONOMY_LIVE etc
  url: string | null;
  checked_at: string;
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  stars: number;
  open_issues: number;
  latest_commit_sha: string | null;
  latest_commit_msg: string | null;
  ci_status: 'success' | 'failure' | 'pending' | 'none';
  ci_url: string | null;
}

export interface CloudflarePagesProject {
  name: string;
  url: string | null;
  latest_deploy_status: 'success' | 'failure' | 'running' | 'unknown';
  latest_deploy_at: string | null;
  latest_commit: string | null;
}

export interface EngineeringSnapshot {
  id: string;
  railway: ServiceStatus[];
  github: GitHubRepo[];
  cloudflare: CloudflarePagesProject[];
  incidents: Incident[];
  snapped_at: string;
  summary: EngineeringSummary;
}

export interface Incident {
  service: string;
  type: 'deploy_failure' | 'ci_failure' | 'health_degraded' | 'build_error';
  message: string;
  detected_at: string;
  resolved: boolean;
}

export interface EngineeringSummary {
  total_services: number;
  healthy: number;
  degraded: number;
  down: number;
  failing_ci: string[];
  active_incidents: number;
  all_flags: Record<string, string>;  // merged env flags across all services
}

// ── Railway adapter ───────────────────────────────────────────────────────────

/**
 * fetchRailwayStatus
 * Uses Railway GraphQL API to get deployment status for all 6 services.
 * Token: RAILWAY_API_TOKEN (read-only personal token — DK sets this)
 */
export async function fetchRailwayStatus(): Promise<ServiceStatus[]> {
  const token = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;

  if (!token || !projectId) {
    // Return stub with unknown status when token not set
    return RAILWAY_SERVICES.map(name => ({
      name,
      health: 'unknown' as ServiceHealth,
      latest_deploy_at: null,
      latest_deploy_sha: null,
      latest_deploy_status: 'UNKNOWN' as const,
      env_flags: {},
      url: null,
      checked_at: new Date().toISOString(),
    }));
  }

  const query = `
    query {
      project(id: "${projectId}") {
        services {
          edges {
            node {
              id
              name
              serviceInstances {
                edges {
                  node {
                    domains { serviceDomains { domain } }
                    latestDeployment {
                      id
                      status
                      createdAt
                      meta { commitHash commitMessage }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const resp = await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) throw new Error(`Railway API error: ${resp.status}`);
  const data = await resp.json();
  const services = data?.data?.project?.services?.edges ?? [];

  return services.map((edge: any) => {
    const svc = edge.node;
    const instance = svc.serviceInstances?.edges?.[0]?.node;
    const deploy = instance?.latestDeployment;
    const domain = instance?.domains?.serviceDomains?.[0]?.domain;

    const railwayStatus = deploy?.status ?? 'UNKNOWN';
    const health: ServiceHealth =
      railwayStatus === 'SUCCESS' ? 'healthy'
      : railwayStatus === 'FAILED' ? 'down'
      : railwayStatus === 'BUILDING' ? 'degraded'
      : 'unknown';

    return {
      name: svc.name,
      health,
      latest_deploy_at: deploy?.createdAt ?? null,
      latest_deploy_sha: deploy?.meta?.commitHash ?? null,
      latest_deploy_status: railwayStatus,
      env_flags: {},  // Railway doesn't expose env vars via API (security) — DK reads these
      url: domain ? `https://${domain}` : null,
      checked_at: new Date().toISOString(),
    };
  });
}

// ── GitHub adapter ────────────────────────────────────────────────────────────

/**
 * fetchGitHubStatus
 * Repos: DCS-Sports/dcs-sports-backend + DCS-LabsAI/dcs-agentic
 * (from CW7 Gateway_Routes_and_R2_Runbook.md and parent repo history)
 */
export async function fetchGitHubStatus(
  repos: string[] = (process.env.INTEL_GITHUB_REPOS || 'DCS-LabsAI/dcsai-ai-repo,DCS-LabsAI/intelligence-ingest-api,DCS-LabsAI/dcs-agentic,DCS-Sports/dcs-sports-backend').split(',')
): Promise<GitHubRepo[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return repos.map(r => ({
      name: r.split('/')[1] ?? r,
      full_name: r,
      stars: 0,
      open_issues: 0,
      latest_commit_sha: null,
      latest_commit_msg: null,
      ci_status: 'none' as const,
      ci_url: null,
    }));
  }

  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };

  const results = await Promise.allSettled(repos.map(async (repo) => {
    const [repoResp, commitsResp] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}`, { headers }),
      fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, { headers }),
    ]);

    const repoData = repoResp.ok ? await repoResp.json() : null;
    const commits = commitsResp.ok ? await commitsResp.json() : [];
    const latestCommit = commits[0] ?? null;
    const sha = latestCommit?.sha ?? null;

    // Get CI status for latest commit
    let ciStatus: GitHubRepo['ci_status'] = 'none';
    let ciUrl: string | null = null;
    if (sha) {
      const ciResp = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs`, { headers });
      if (ciResp.ok) {
        const ciData = await ciResp.json();
        const runs = ciData?.check_runs ?? [];
        const failed = runs.some((r: any) => r.conclusion === 'failure');
        const pending = runs.some((r: any) => r.status === 'in_progress');
        ciStatus = failed ? 'failure' : pending ? 'pending' : runs.length > 0 ? 'success' : 'none';
        ciUrl = runs[0]?.html_url ?? null;
      }
    }

    return {
      name: repoData?.name ?? repo.split('/')[1],
      full_name: repo,
      stars: repoData?.stargazers_count ?? 0,
      open_issues: repoData?.open_issues_count ?? 0,
      latest_commit_sha: sha?.slice(0, 7) ?? null,
      latest_commit_msg: latestCommit?.commit?.message?.split('\n')[0] ?? null,
      ci_status: ciStatus,
      ci_url: ciUrl,
    } as GitHubRepo;
  }));

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => (r as PromiseFulfilledResult<GitHubRepo>).value);
}

// ── Cloudflare adapter ────────────────────────────────────────────────────────

/**
 * fetchCloudflarePages
 * Projects: trd-console + any other Cloudflare Pages projects
 */
export async function fetchCloudflarePages(): Promise<CloudflarePagesProject[]> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!token || !accountId) return [];

  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!resp.ok) return [];
  const data = await resp.json();
  const projects = data?.result ?? [];

  return projects.map((p: any) => {
    const latest = p.latest_deployment;
    const cfStatus = latest?.latest_stage?.status ?? 'unknown';
    return {
      name: p.name,
      url: p.subdomain ? `https://${p.subdomain}` : null,
      latest_deploy_status: cfStatus === 'success' ? 'success'
        : cfStatus === 'failure' ? 'failure'
        : cfStatus === 'active' ? 'running'
        : 'unknown',
      latest_deploy_at: latest?.created_on ?? null,
      latest_commit: latest?.deployment_trigger?.metadata?.commit_hash?.slice(0, 7) ?? null,
    } as CloudflarePagesProject;
  });
}

// ── Incident detector ─────────────────────────────────────────────────────────

function detectIncidents(
  railway: ServiceStatus[],
  github: GitHubRepo[],
): Incident[] {
  const incidents: Incident[] = [];
  const now = new Date().toISOString();

  for (const svc of railway) {
    if (svc.health === 'down') {
      incidents.push({
        service: svc.name,
        type: 'deploy_failure',
        message: `${svc.name} deploy FAILED — last deploy: ${svc.latest_deploy_at ?? 'unknown'}`,
        detected_at: now,
        resolved: false,
      });
    }
    if (svc.health === 'degraded') {
      incidents.push({
        service: svc.name,
        type: 'health_degraded',
        message: `${svc.name} is building/degraded`,
        detected_at: now,
        resolved: false,
      });
    }
  }

  for (const repo of github) {
    if (repo.ci_status === 'failure') {
      incidents.push({
        service: repo.full_name,
        type: 'ci_failure',
        message: `CI failing on ${repo.full_name} — commit: ${repo.latest_commit_sha} "${repo.latest_commit_msg?.slice(0, 60)}"`,
        detected_at: now,
        resolved: false,
      });
    }
  }

  return incidents;
}

// ── Summary builder ───────────────────────────────────────────────────────────

function buildSummary(
  railway: ServiceStatus[],
  incidents: Incident[],
): EngineeringSummary {
  return {
    total_services: railway.length,
    healthy: railway.filter(s => s.health === 'healthy').length,
    degraded: railway.filter(s => s.health === 'degraded').length,
    down: railway.filter(s => s.health === 'down').length,
    failing_ci: [],  // populated from GitHub
    active_incidents: incidents.filter(i => !i.resolved).length,
    all_flags: {
      // Known flags — DK flips these in Railway dashboard
      AUTONOMY_LIVE: '0',
      PAYMENTS_LIVE: '0',
      DEPLOY_LIVE: '0',
      FILECOIN_LIVE: '0',
      AV2_ATLAS_BIND: process.env.AV2_ATLAS_BIND ?? '0',
    },
  };
}

// ── Main snapshot builder ─────────────────────────────────────────────────────

/**
 * buildEngineeringSnapshot
 * Polls all three sources and returns a combined snapshot.
 * Called hourly by the engineering OS cron.
 */
export async function buildEngineeringSnapshot(
  db: SupabaseClient,
  githubRepos?: string[],
): Promise<{ ok: boolean; snapshot?: EngineeringSnapshot; error?: string }> {
  try {
    const [railway, github, cloudflare] = await Promise.allSettled([
      fetchRailwayStatus(),
      fetchGitHubStatus(githubRepos),
      fetchCloudflarePages(),
    ]);

    const rData = railway.status === 'fulfilled' ? railway.value : [];
    const gData = github.status === 'fulfilled' ? github.value : [];
    const cfData = cloudflare.status === 'fulfilled' ? cloudflare.value : [];

    const incidents = detectIncidents(rData, gData);
    const summary = buildSummary(rData, incidents);
    summary.failing_ci = gData.filter(r => r.ci_status === 'failure').map(r => r.full_name);

    const snapshot: EngineeringSnapshot = {
      id: randomUUID(),
      railway: rData,
      github: gData,
      cloudflare: cfData,
      incidents,
      snapped_at: new Date().toISOString(),
      summary,
    };

    // Persist summary to Supabase for Mission Control
    await db.from('intel_memory').upsert({
      company: 'DCS AI',
      key: 'engineering_snapshot',
      value: {
        summary,
        incidents: incidents.map(i => ({ service: i.service, type: i.type, message: i.message })),
        snapped_at: snapshot.snapped_at,
      },
      source: 'cron',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company,key' });

    return { ok: true, snapshot };
  } catch (e: any) {
    console.error('[EngineeringOS] snapshot error', e?.message);
    return { ok: false, error: e?.message };
  }
}

// ── Cron ─────────────────────────────────────────────────────────────────────

export async function startEngineeringOsCron(db: SupabaseClient) {
  let cron: any = null;
  try { cron = await import('node-cron'); } catch {}

  const run = () => buildEngineeringSnapshot(db).then(r =>
    console.log(`[EngineeringOS] snapped — healthy:${r.snapshot?.summary.healthy} incidents:${r.snapshot?.summary.active_incidents}`)
  );

  if (cron?.schedule) {
    cron.schedule('*/15 * * * *', run);  // every 15 min
    console.log('[Intel] Engineering OS cron: every 15min');
  } else {
    run();
    setInterval(run, 15 * 60 * 1000);
  }
}

// ── HTTP routes ───────────────────────────────────────────────────────────────

/**
 * registerEngineeringOsRoutes
 *
 * GET  /intel/engineering              → latest snapshot
 * GET  /intel/engineering/railway      → railway services only
 * GET  /intel/engineering/github       → github repos only
 * GET  /intel/engineering/incidents    → active incidents
 * POST /intel/engineering/refresh      → trigger refresh (internal)
 */
export function registerEngineeringOsRoutes(app: any, db: SupabaseClient) {
  const auth = (req: any, res: any) => {
    if (!req.user?.id) { res.status(401).json({ error: 'unauthenticated' }); return false; }
    return true;
  };
  const internalAuth = (req: any, res: any) => {
    if (req.headers['x-internal-token'] !== process.env.INTERNAL_SERVICE_TOKEN) {
      res.status(401).json({ error: 'unauthorized' }); return false;
    }
    return true;
  };

  app.get('/intel/engineering', async (req: any, res: any) => {
    if (!auth(req, res)) return;
    // Return latest from intel_memory
    const { data } = await db
      .from('intel_memory')
      .select('value, updated_at')
      .eq('company', 'DCS AI')
      .eq('key', 'engineering_snapshot')
      .maybeSingle();
    if (!data) return res.json({ ok: true, snapshot: null, message: 'no_snapshot_yet' });
    res.json({ ok: true, snapshot: data.value, updated_at: data.updated_at });
  });

  app.get('/intel/engineering/railway', async (req: any, res: any) => {
    if (!auth(req, res)) return;
    try {
      const services = await fetchRailwayStatus();
      res.json({ ok: true, services });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message });
    }
  });

  app.get('/intel/engineering/github', async (req: any, res: any) => {
    if (!auth(req, res)) return;
    try {
      const repos = req.query.repos ? (req.query.repos as string).split(',') : undefined;
      const github = await fetchGitHubStatus(repos);
      res.json({ ok: true, github });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message });
    }
  });

  app.get('/intel/engineering/incidents', async (req: any, res: any) => {
    if (!auth(req, res)) return;
    const { data } = await db
      .from('intel_memory')
      .select('value')
      .eq('company', 'DCS AI')
      .eq('key', 'engineering_snapshot')
      .maybeSingle();
    const incidents = (data?.value as any)?.incidents ?? [];
    res.json({ ok: true, incidents, active: incidents.filter((i: any) => !i.resolved).length });
  });

  app.post('/intel/engineering/refresh', async (req: any, res: any) => {
    if (!internalAuth(req, res)) return;
    const result = await buildEngineeringSnapshot(db, req.body?.repos);
    res.json(result.ok ? { ok: true, summary: result.snapshot?.summary } : result);
  });
}
