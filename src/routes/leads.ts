// src/routes/leads.ts
// PUBLIC lead capture + funnel analytics for the marketing site.
// - POST /public/leads   : qualified academy / league / football-pilot / scout leads
// - POST /public/events  : lightweight funnel events (hero_demo_clicked, passport_claim_started, ...)
// No auth (public site posts here). Light validation, size caps, no PII in URLs.
// Notification: fire-and-forget Resend email if configured (same pattern as /public/claims).

import { Router } from 'express';
import { fail, h, svc, ok } from './_helpers';
import type { AuthedRequest } from '../middleware/auth';

export const leadsRouter = Router();

const LEAD_KINDS = new Set(['academy', 'league', 'football_pilot', 'scout', 'tennis_research', 'other']);
const EV_NAMES = new Set([
  'hero_demo_clicked', 'demo_match_opened', 'demo_match_completed',
  'passport_claim_started', 'passport_claim_completed',
  'academy_page_viewed', 'academy_form_started', 'academy_lead_submitted',
  'league_lead_submitted', 'pricing_viewed',
  'football_waitlist_joined', 'tennis_research_joined',
]);

const s = (v: any, n: number) => (v == null ? null : String(v).trim().slice(0, n) || null);

// POST /public/leads — one endpoint, `kind` decides the funnel.
leadsRouter.post('/public/leads', h(async (req: AuthedRequest, res) => {
  const b = req.body ?? {};
  const kind = String(b.kind || '').trim();
  if (!LEAD_KINDS.has(kind)) return fail(res, 400, 'invalid kind');
  const name = s(b.name, 160);            // org or person name
  const contact = s(b.contact, 160);      // email or phone
  if (!name || !contact) return fail(res, 400, 'name and contact required');
  const row = {
    kind,
    name,
    contact,
    city: s(b.city, 120),
    athletes: s(b.athletes, 40),          // ranges as text: "100-500"
    coaches: s(b.coaches, 40),
    teams: s(b.teams, 40),
    matches_per_month: s(b.matches_per_month, 40),
    scoring_process: s(b.scoring_process, 300),
    camera_interest: b.camera_interest === true || b.camera_interest === 'yes',
    preferred_time: s(b.preferred_time, 120),
    dates: s(b.dates, 160),
    note: s(b.note, 500),
    utm_source: s(b.utm_source, 80),
    utm_medium: s(b.utm_medium, 80),
    utm_campaign: s(b.utm_campaign, 120),
    utm_content: s(b.utm_content, 120),
    status: 'new',
  };
  const { error } = await svc().from('sports_leads').insert(row);
  if (error) return fail(res, 400, error.message);
  if (process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL) {
    const esc = (v: any) => String(v ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as any)[c]);
    const html = `<p>New <b>${esc(kind)}</b> lead from the DCS Sports site.</p>`
      + `<ul><li><b>Name:</b> ${esc(name)}</li><li><b>Contact:</b> ${esc(contact)}</li>`
      + `<li><b>City:</b> ${esc(row.city || '—')}</li><li><b>Matches/mo:</b> ${esc(row.matches_per_month || '—')}</li>`
      + `<li><b>Camera:</b> ${row.camera_interest ? 'yes' : 'no/unsure'}</li>`
      + `<li><b>Campaign:</b> ${esc(row.utm_campaign || 'direct')}</li></ul>`;
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'DCS Sports <onboarding@resend.dev>', to: process.env.NOTIFY_EMAIL, subject: `New ${kind} lead: ${name}`, html }),
    }).catch(() => {});
  }
  return ok(res, { received: true });
}));

// POST /public/events — funnel beacon. Accepts sendBeacon (text/plain) or JSON.
leadsRouter.post('/public/events', h(async (req: AuthedRequest, res) => {
  let b: any = req.body ?? {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  const name = String(b.name || '').trim();
  if (!EV_NAMES.has(name)) return fail(res, 400, 'unknown event');
  const row = {
    name,
    page: s(b.page, 200),
    utm_source: s(b.utm_source, 80),
    utm_medium: s(b.utm_medium, 80),
    utm_campaign: s(b.utm_campaign, 120),
    utm_content: s(b.utm_content, 120),
    ref: s(b.ref, 200),
  };
  const { error } = await svc().from('sports_web_events').insert(row);
  if (error) return fail(res, 400, error.message);
  return ok(res, { received: true });
}));
