// ============================================================================
// server_v2.ts · DCS Intelligence Ingest API — v2
// ============================================================================
// Upgrades server.mjs (raw Node http) to Express + TypeScript.
// Registers all Intel v2 route modules.
// Backward-compatible: preserves /api/intelligence/* and /api/integrations/*
//
// SECURITY RULES (must remain in effect):
//   - Money + autonomy stay DARK until Phase 4 (AUTOMATION_LIVE env var)
//   - POST_LIVE=0 — scheduler never auto-posts
//   - Only DK deploys/flips — secrets never set in chat
//   - Fail-open: no module crash takes down the whole server
//
// To switch from server.mjs → server_v2.ts:
//   1. `npm install express @types/express @supabase/supabase-js node-cron`
//   2. Set Railway start command: `node --loader ts-node/esm server_v2.ts`
//      or compile first: `npx tsc && node dist/server_v2.js`
//   3. Set env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PORT
// ============================================================================

import express, { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

// ── Intel v2 route modules ────────────────────────────────────────────────────
import { registerIntelContextRoutes } from './intel_context_api.js';
import { registerIntelCampaignRoutes } from './intel_campaigns_api.js';
import { registerMarketingMemoryRoutes } from './intel_marketing_memory.js';
import { registerMorningBriefRoutes, startMorningBriefCron } from './intel_morning_brief.js';
import { registerSocialRoutes, startSocialSyncCron } from './intel_social_connectors.js';
import { registerEngineeringOsRoutes, startEngineeringOsCron } from './intel_engineering_os.js';
import { registerMediumRoutes, mediumConnectorStatus } from './intel_medium_connector.js';

// ── Legacy modules (from server.mjs) ─────────────────────────────────────────
// Keep these alive so existing Railway routes don't break
import { ingestHandler, ingested } from './src/CW24_AgenticV2_intelligence-ingest.mjs';
import { catalog } from './src/CW24_AgenticV2_marketplace-explorer.mjs';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '8082', 10);

// Money / autonomy dark flags (must remain 0 until Phase 4)
const MONEY_DARK     = (process.env.AUTOMATION_LIVE ?? '0') !== '1';
const POST_LIVE      = (process.env.POST_LIVE       ?? '0') === '1';
const AV2_ATLAS_BIND = (process.env.AV2_ATLAS_BIND  ?? '0') === '1';

// ── Supabase ──────────────────────────────────────────────────────────────────

let db: ReturnType<typeof createClient> | null = null;

function getDb(): ReturnType<typeof createClient> {
  if (!db) {
    const url  = process.env.SUPABASE_URL;
    const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    db = createClient(url, key);
  }
  return db;
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS — allow all origins (same as server.mjs)
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-dashboard-token,x-device-id');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

// ── Auth middleware (light — token from env or header) ────────────────────────
// Intel v2 endpoints check `Authorization: Bearer <token>`
// If INTEL_API_SECRET is not set, all requests pass (development mode)
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.INTEL_API_SECRET;
  if (!secret) return next(); // no secret configured → open (dev mode)

  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7)
               : (req.headers['x-dashboard-token'] as string || '');

  if (token !== secret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// ── Health endpoint ───────────────────────────────────────────────────────────

app.get(['/health', '/healthz'], (_req, res) => {
  const medium = mediumConnectorStatus();
  res.json({
    ok: true,
    service: 'dcs-intelligence-ingest-v2',
    version: '2.0.0',
    flags: {
      MONEY_DARK,
      POST_LIVE,
      AV2_ATLAS_BIND,
      AUTONOMY: 'DARK',           // never changes until Phase 4 DK flip
      PAYMENTS_LIVE: false,       // Phase 4 gate
    },
    connectors: {
      supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      medium: medium.configured,
      medium_post_live: medium.post_live,
      railway: !!process.env.RAILWAY_API_TOKEN,
      github: !!process.env.GITHUB_TOKEN,
      cloudflare: !!process.env.CLOUDFLARE_API_TOKEN,
      linkedin: !!process.env.LINKEDIN_ACCESS_TOKEN,
      x: !!process.env.X_BEARER_TOKEN,
      youtube: !!process.env.YOUTUBE_API_KEY,
      discord: !!process.env.DISCORD_BOT_TOKEN_TRD,
      telegram: !!(process.env.TELEGRAM_BOT_TOKEN_TRD && process.env.TELEGRAM_CHANNEL_CHAT_ID_TRD && process.env.TELEGRAM_GROUP_CHAT_ID_TRD),
      telegram_bot: !!process.env.TELEGRAM_BOT_TOKEN_TRD,
      telegram_channel: !!process.env.TELEGRAM_CHANNEL_CHAT_ID_TRD,
      telegram_group: !!process.env.TELEGRAM_GROUP_CHAT_ID_TRD,
      hashnode: !!process.env.HASHNODE_TOKEN,
      devto: !!process.env.DEVTO_API_KEY,
    },
    timestamp: new Date().toISOString(),
  });
});

// ── Legacy routes (backward-compat with server.mjs) ──────────────────────────

app.get('/api/integrations/marketplace', (_req, res) => {
  res.json({ catalog: catalog() });
});

app.get('/api/intelligence/feed', (_req, res) => {
  res.json({
    pending: ingested(),
    note: 'DARK in-memory sink; DK wires the real Intelligence store (Supabase/warehouse)',
  });
});

app.post('/api/intelligence/ingest', (req, res) => {
  const r = ingestHandler({ body: req.body });
  res.status(r.status).json(r.json);
});

// ── Intel v2 route modules ────────────────────────────────────────────────────
// Each module gets (app, db) and registers its own routes under /intel/*
// Auth middleware applied to all /intel/* routes
// Fail-open: if a module throws during registration, log + skip it

app.use('/intel', authMiddleware);

const DB_REQUIRED_MODULES: Array<{
  name: string;
  register: (app: any, db: any) => void;
}> = [
  { name: 'intel_context_api',      register: registerIntelContextRoutes },
  { name: 'intel_campaigns_api',    register: registerIntelCampaignRoutes },
  { name: 'intel_marketing_memory', register: registerMarketingMemoryRoutes },
  { name: 'intel_morning_brief',    register: registerMorningBriefRoutes },
  { name: 'intel_social_connectors',register: registerSocialRoutes },
  { name: 'intel_engineering_os',   register: registerEngineeringOsRoutes },
  { name: 'intel_medium_connector', register: registerMediumRoutes },
];

function registerAllModules() {
  let dbInstance: ReturnType<typeof createClient> | null = null;

  try {
    dbInstance = getDb();
  } catch (err: any) {
    console.warn('[Intel v2] Supabase not configured — /intel/* routes will return 503 until env vars are set:', err.message);
  }

  for (const mod of DB_REQUIRED_MODULES) {
    try {
      if (!dbInstance) {
        // Register a stub that returns 503 so the server still starts
        app.all(`/intel/*`, (_req: Request, res: Response) => {
          if (!res.headersSent) {
            res.status(503).json({ ok: false, error: 'Supabase not configured. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.' });
          }
        });
        break; // Only need one stub handler
      }
      mod.register(app, dbInstance);
      console.log(`[Intel v2] ✓ Registered: ${mod.name}`);
    } catch (err: any) {
      console.error(`[Intel v2] ✗ Failed to register ${mod.name}:`, err.message);
      // Fail-open: continue registering other modules
    }
  }
}

// ── Static files (Mission Control, Editorial Calendar, etc.) ─────────────────
// Serve /intelligence-ingest-api/public/* at /app/*
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

app.use('/app', express.static(join(__dirname, 'public')));

// Convenience redirects
app.get('/', (_req, res) => res.redirect('/app/mission_control.html'));
app.get('/mission-control',    (_req, res) => res.redirect('/app/mission_control.html'));
app.get('/editorial-calendar', (_req, res) => res.redirect('/app/editorial_calendar.html'));
app.get('/content-library',    (_req, res) => res.redirect('/app/content_library.html'));
app.get('/agent-os',           (_req, res) => res.redirect('/app/agent_os.html'));
app.get('/social-analytics',   (_req, res) => res.redirect('/app/social_analytics.html'));
app.get('/executive-os',       (_req, res) => res.redirect('/app/executive_os.html'));

// ── 404 fallback ──────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

function startCrons() {
  // Only start crons if Supabase is configured
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[Intel v2] Crons skipped — Supabase not configured');
    return;
  }

  try {
    const companies = (process.env.INTEL_COMPANIES || 'TRD,DCS AI,DCS Labs,DCS Rank,DCS Sports,DCS Games').split(',');
    // 3am UTC: Marketing Memory
    // 6am UTC: Morning Brief
    startMorningBriefCron(getDb(), process.env.INTEL_DEFAULT_USER_ID || 'dk', companies[0] || 'TRD');
    // Hourly: Social sync
    startSocialSyncCron(getDb(), companies);
    // Every 15min: Engineering OS
    startEngineeringOsCron(getDb());
    console.log('[Intel v2] ✓ Crons started: marketing-memory(3am), morning-brief(6am), social-sync(hourly), engineering-os(15min)');
  } catch (err: any) {
    console.error('[Intel v2] Cron start failed:', err.message);
  }
}

registerAllModules();
startCrons();

app.listen(PORT, () => {
  console.log(JSON.stringify({
    msg: 'dcs-intelligence-ingest-v2 up',
    port: PORT,
    flags: { MONEY_DARK, POST_LIVE, AV2_ATLAS_BIND, AUTONOMY: 'DARK' },
    ui: {
      mission_control:    `http://localhost:${PORT}/app/mission_control.html`,
      editorial_calendar: `http://localhost:${PORT}/app/editorial_calendar.html`,
      content_library:    `http://localhost:${PORT}/app/content_library.html`,
      agent_os:           `http://localhost:${PORT}/app/agent_os.html`,
      social_analytics:   `http://localhost:${PORT}/app/social_analytics.html`,
      executive_os:       `http://localhost:${PORT}/app/executive_os.html`,
    },
    api: {
      context:     `GET /intel/context`,
      campaigns:   `GET /intel/campaigns`,
      memory:      `GET /intel/memory/:company`,
      brief:       `GET /intel/brief/today`,
      social:      `GET /intel/social`,
      engineering: `GET /intel/engineering`,
      medium:      `GET /intel/medium/articles`,
    },
  }));
});

export default app;

// ── DK Action Card ────────────────────────────────────────────────────────────
// To deploy this server:
//
// 1. npm install express @types/express @supabase/supabase-js node-cron ts-node
// 2. Set Railway env vars:
//      SUPABASE_URL=...
//      SUPABASE_SERVICE_ROLE_KEY=...
//      INTEL_API_SECRET=<generate a new secret, DO NOT use the compromised token>
//      INTEL_COMPANIES=TRD,DCS AI,DCS Labs,DCS Rank,DCS Sports,DCS Games
//      INTEL_DEFAULT_USER_ID=dk
//      POST_LIVE=0          ← keep 0 until billing/microVM ready
//      AUTOMATION_LIVE=0    ← keep 0 until Phase 4
// 3. Run INTEL_V2_MIGRATIONS_SQL from intel_campaigns_api.ts in Supabase SQL editor
// 4. Update Railway start command: npx ts-node --esm server_v2.ts
//    (or: npx tsc && node dist/server_v2.js)
