// src/gateway/server.ts
// CW16 = integration owner. ONE deployed backend. All lane routers (CW9–CW15)
// mount here, backed by the live `dcs-sports` Supabase. CW16's native surfaces
// (revenue DARK, agents+gate, alerts) live alongside. Money DARK · AI estimate.
import express, { Request, Response } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { buildRevenueEvent } from '../revenue/splits';
import { writeSuggestion, actionSuggestion } from '../agents/gate';
import { evaluateAlerts } from '../alerts/engine';
import { modelCharge } from '../revenue/router';
import { getServiceClient } from '../db/supabase';
import { rateLimit } from '../middleware/rate_limit';
import { requireAdmin } from '../middleware/admin';

import { identityRouter } from '../routes/identity';
import { athleteRouter } from '../routes/athletes';
import { academyRouter } from '../routes/academy';
import { leagueRouter } from '../routes/league';
import { matchDbRouter } from '../routes/match_db';
import { intelRouter } from '../routes/intel';
import { leadsRouter } from '../routes/leads';
import { verifyRouter } from '../routes/verify';
import { scoutRouter } from '../routes/scout';
import { visionRouter } from '../routes/vision';
import { reputationRouter } from '../routes/reputation';
import cw14Marketplace from '../cw14/routes/marketplace';
import cw14Opportunities from '../cw14/routes/opportunities';
import { mountCW12Additive } from '../cw12/gateway-mount';
import { registerCw13Routes } from '../cw13/index';
import { mountCw15 } from '../cw15/gateway';
import { mountCW9 } from '../cw9/mount';

export function createApp() {
  const app = express();

  /* 🔴 CORS — THE MISSING WIRE.   15 Jul 2026
   *
   * ALLOWED_ORIGINS was set in Railway and read by NOTHING. This gateway set zero Access-Control
   * headers and installed no cors package, so the browser app (app.sports.dcsai.ai) was blocked by
   * the browser on every cross-origin call to identity/athletes/passport — which is the real cause
   * of "Could not load passport. Try again." The env var was a phantom.
   *
   * This finally reads it. No new dependency — an inline middleware is smaller than the `cors`
   * package and does exactly what is needed and nothing more:
   *   · origin is echoed ONLY if it is on the allowlist (never a blanket "*", because Authorization
   *     is a credentialed header and "*" + credentials is both unsafe and rejected by browsers);
   *   · Authorization is allowed (the passport bearer token) — without this the fix does nothing;
   *   · OPTIONS preflight is answered 204 before auth/rate-limit, or every POST fails silently.
   *
   * ALLOWED_ORIGINS is a comma-separated list, e.g.
   *   https://app.sports.dcsai.ai,https://sports.dcsai.ai
   * If it is UNSET the middleware allows nothing cross-origin and logs a warning — it fails CLOSED,
   * loudly, rather than silently allowing everything. Set it in Railway before the app can talk.
   */
  const ALLOWED = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',').map(o => o.trim()).filter(Boolean);
  if (ALLOWED.length === 0) {
    console.warn('[cors] ALLOWED_ORIGINS is empty — every cross-origin browser call will be refused. ' +
      'Set it in Railway, e.g. "https://app.sports.dcsai.ai,https://sports.dcsai.ai".');
  }
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, apikey, x-client-info');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    // Preflight must be answered BEFORE auth/rate-limit, or the real request never fires.
    if (req.method === 'OPTIONS') return res.sendStatus(origin && ALLOWED.includes(origin) ? 204 : 403);
    next();
  });

  app.use(express.json());

  // Rate limit all but health checks (monitoring must stay reachable).
  const limiter = rateLimit({ capacity: 60, refillPerSec: 5 });
  app.use((req, res, next) => {
    if (req.path.startsWith('/health')) return next();
    return limiter(req, res, next);
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: 'dcs-sports-backend',
      lane: 'CW16 (integration owner)',
      money: 'DARK',
      rails: ['razorpay', 'stripe'],
      mounted_lanes: ['identity', 'athletes', 'academy', 'league', 'verify', 'scout', 'vision'],
    });
  });

  // Deep health — probes live Supabase + Redis, posture, gate rollup. No secrets.
  app.get('/health/deep', async (_req: Request, res: Response) => {
    const { deepHealth } = require('./monitoring');
    const h = await deepHealth();
    res.status(h.healthy ? 200 : 503).json(h);
  });

  // Readiness — fast 200/503 for Railway healthcheck (down dep => 503).
  app.get('/health/ready', async (_req: Request, res: Response) => {
    const { deepHealth } = require('./monitoring');
    const h = await deepHealth();
    res.status(h.healthy ? 200 : 503).json({ ready: h.healthy, supabase: h.dependencies.supabase.status, redis: h.dependencies.redis.status });
  });

  /* ─────────────────────────────────────────────────────────────────────────────────────────────
   * POST /contact — the marketing site's contact form.   15 Jul 2026
   *
   * Public (no auth), rate-limited, CORS-covered (sports.dcsai.ai is in ALLOWED_ORIGINS). It sends
   * via Resend using RESEND_API_KEY + RESEND_SENDER_EMAIL from the Railway env.
   *
   * 🔴 HONESTY RULE, same as everywhere in this codebase: it NEVER claims a message was sent unless
   * Resend confirms it. If the key is not configured it returns 503 and SAYS SO — it does not
   * pretend. A silent success on a contact form is the bug we removed from the site; we do not
   * relocate it into the backend.
   */
  app.post('/contact', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? '').trim();
    const email = String(b.email ?? '').trim();
    const role = String(b.role ?? '').trim();
    const message = String(b.message ?? '').trim();
    const RECIPIENT = process.env.RESEND_CONTACT_TO || 'hello@dcsai.ai';
    const FROM = process.env.RESEND_SENDER_EMAIL || 'noreply@dcsai.ai';

    if (!name || !email || !message) return res.status(400).json({ ok: false, error: 'Name, email and message are required.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'That email address does not look right.' });
    if (message.length > 5000) return res.status(400).json({ ok: false, error: 'That message is too long.' });

    if (!process.env.RESEND_API_KEY) {
      return res.status(503).json({ ok: false,
        error: 'The contact service is not configured, so your message was NOT sent. Please email ' + RECIPIENT + ' directly.' });
    }

    const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: `DCS Sports <${FROM}>`, to: [RECIPIENT], reply_to: email,
          subject: `DCS Sports — ${role || 'enquiry'} — ${name}`,
          html: `<p><b>Name:</b> ${esc(name)}</p><p><b>Email:</b> ${esc(email)}</p>`
              + (role ? `<p><b>Role:</b> ${esc(role)}</p>` : '')
              + `<p><b>Message:</b></p><p>${esc(message).replace(/\n/g, '<br>')}</p>`,
        }),
      });
      if (!r.ok) {
        return res.status(502).json({ ok: false,
          error: 'We could not send your message just now. Please email ' + RECIPIENT + ' directly.' });
      }
      return res.status(200).json({ ok: true });
    } catch (e: any) {
      return res.status(502).json({ ok: false,
        error: 'We could not reach the mail service. Please email ' + RECIPIENT + ' directly.', detail: String(e?.message).slice(0, 120) });
    }
  });

  // Compact status rollup for the status page (no secrets).
  const bootedAt = Date.now();
  app.get('/status', async (_req: Request, res: Response) => {
    const { deepHealth } = require('./monitoring');
    const h = await deepHealth();
    res.json({
      service: 'dcs-sports-backend',
      uptime_s: Math.floor((Date.now() - bootedAt) / 1000),
      healthy: h.healthy,
      money: h.posture.money,
      gates: h.gates,
      dependencies: { supabase: h.dependencies.supabase.status, redis: h.dependencies.redis.status },
    });
  });

  // Admin-guarded M-S1 self-check — runs the real chain on live DB + cleans up.
  app.post('/selfcheck/ms1', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { selfCheckMS1 } = require('../harness/selfcheck');
      const result = await selfCheckMS1();
      res.status(result.passed ? 200 : 500).json(result);
    } catch (e: any) {
      res.status(503).json({ error: e.message });
    }
  });

  app.post('/revenue/quote', async (req: Request, res: Response) => {
    const { source, athlete_id, gross_paise, persist } = req.body ?? {};
    try {
      const event = buildRevenueEvent(source, athlete_id ?? null, Number(gross_paise));
      if (persist) {
        const { error } = await getServiceClient().from('sports_revenue_events').insert({
          source: event.source, athlete_id: event.athlete_id, gross: event.gross,
          splits_json: event.splits_json, mode: event.mode,
        });
        if (error) throw new Error(error.message);
      }
      res.json({ event, persisted: Boolean(persist), note: 'TEST MODE — no money moved.' });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/revenue/charge/test', (req: Request, res: Response) => {
    const { country_code, amount_minor, reference, currency, metadata } = req.body ?? {};
    try {
      res.json(modelCharge({ countryCode: country_code ?? 'IN', amountMinor: Number(amount_minor), reference, currency, metadata }));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/agents/suggest', async (req: Request, res: Response) => {
    try { res.json(await writeSuggestion(req.body)); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.post('/agents/suggestions/:id/action', requireAuth, async (req: AuthedRequest, res: Response) => {
    try { res.json(await actionSuggestion(req.params.id, { user_id: 'human', is_human: true })); }
    catch (e: any) { res.status(403).json({ error: e.message }); }
  });

  app.post('/alerts/evaluate', (req: Request, res: Response) => {
    res.json({ alerts: evaluateAlerts(req.body) });
  });

  // ---- CW16 native: run the Autonomous Agent Layer tick on demand ----
  // The worker runs this on a schedule; this lets DK/harness fire one now.
  app.post('/agents/tick/run', async (_req: Request, res: Response) => {
    try {
      const { executeTick } = require('../agents/runner');
      const result = await executeTick();
      res.json({ ...result, note: 'high-stakes suggestions written pending human action' });
    } catch (e: any) {
      res.status(503).json({ error: e.message });
    }
  });

  // mounted lane routers (replace Day-0 stubs)
  app.use(identityRouter);
  app.use(athleteRouter);
  app.use(academyRouter);
  app.use(leagueRouter);
  app.use(matchDbRouter); // DB-backed create-match / teams / scorecard / center / commentary — MUST precede CW12 in-memory
  app.use(intelRouter); // CW4/5/6: match twin · tactical copilot · calibration · evidence passport
  app.use(leadsRouter); // PUBLIC marketing leads + funnel events
  app.use(verifyRouter);
  app.use(scoutRouter);
  app.use(visionRouter);
  app.use(reputationRouter);
  app.use(cw14Marketplace);
  app.use(cw14Opportunities);
  mountCW12Additive(app);
  registerCw13Routes(app, '/verification');
  mountCw15(app);
  mountCW9(app, { installAuth: true });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 8080);
  createApp().listen(port, () => console.log(`[dcs-sports] integrated gateway on :${port} (money DARK)`));
}
