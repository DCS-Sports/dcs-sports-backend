// CW14 · v3.0 ROUTES — Opportunity Marketplace + DCS Talent Graph.
// Marketplace: post opportunity → match (RLS-safe, minors excluded) → surface to
// athletes → athlete/guardian consents → acted on. Money DARK.
// Graph: shortest-path discovery + connections; minor endpoints gated.

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  createOpportunity, listOpportunities, getOpportunity,
  saveMatches, listMatchesForAthlete, getMatch, updateMatch,
  loadGraphData, isMinor,
} from '../lib/data';
import { matchOpportunity } from '../lib/matcher';
import { buildGraph } from '../lib/graph';
import { callerJwt } from '../lib/jwt';
import { mockAthletes } from '../mocks/fixtures';
import type { Opportunity } from '../lib/contracts';

const router = Router();

function athleteIsMinor(athlete_id: string): boolean {
  const a = mockAthletes.find((x) => x.id === athlete_id);
  return a ? isMinor(a.dob) : false;
}

// ── MARKETPLACE ──

// POST /opportunities — post an opening (academy/scout/sponsor/agent). Money DARK.
router.post('/opportunities', async (req: Request, res: Response) => {
  try {
    const { type, posted_by, title, sport, criteria, value_amount, currency } = req.body ?? {};
    const opp: Opportunity = {
      id: randomUUID(),
      type: type ?? 'trial',
      posted_by: posted_by ?? 'usr_scout_1',
      title: title ?? 'Untitled opportunity',
      sport: sport ?? null,
      criteria_json: criteria ?? {},
      value_amount: value_amount ?? null,
      currency: currency ?? null,
      status: 'open',
      created_at: new Date().toISOString(),
    };
    res.status(201).json(await createOpportunity(opp));
  } catch (e: any) {
    res.status(500).json({ error: 'opportunity_create_failed', detail: String(e?.message ?? e) });
  }
});

// GET /opportunities?type=&sport=&status=
router.get('/opportunities', async (req: Request, res: Response) => {
  try {
    const { type, sport, status } = req.query as Record<string, string>;
    const rows = await listOpportunities({ type, sport, status });
    res.json({ count: rows.length, opportunities: rows });
  } catch (e: any) {
    res.status(500).json({ error: 'opportunities_list_failed', detail: String(e?.message ?? e) });
  }
});

// POST /opportunities/:id/match — run the matcher; surface matches (RLS-safe, minors excluded)
router.post('/opportunities/:id/match', async (req: Request, res: Response) => {
  try {
    const opp = await getOpportunity(req.params.id);
    if (!opp) return res.status(404).json({ error: 'opportunity_not_found' });
    const matches = await matchOpportunity(opp, callerJwt(req), Number(req.body?.threshold ?? 0.6));
    await saveMatches(matches);
    res.json({ opportunity_id: opp.id, surfaced: matches.length, matches });
  } catch (e: any) {
    res.status(500).json({ error: 'match_failed', detail: String(e?.message ?? e) });
  }
});

// GET /athletes/:id/opportunities — matches surfaced TO an athlete (didn't search for them)
router.get('/athletes/:id/opportunities', async (req: Request, res: Response) => {
  try {
    const rows = await listMatchesForAthlete(req.params.id);
    res.json({ count: rows.length, matches: rows });
  } catch (e: any) {
    res.status(500).json({ error: 'athlete_opps_failed', detail: String(e?.message ?? e) });
  }
});

// POST /matches/:id/consent — athlete (or guardian, if minor) accepts surfacing → actionable
router.post('/matches/:id/consent', async (req: Request, res: Response) => {
  try {
    const m = await getMatch(req.params.id);
    if (!m) return res.status(404).json({ error: 'match_not_found' });
    // a minor's match requires a guardian actor; record consent before it's actionable
    if (athleteIsMinor(m.athlete_id) && !req.body?.parent_user_id) {
      return res.status(409).json({ error: 'parent_consent_required', detail: 'minor opportunity needs guardian consent' });
    }
    m.consented = true;
    m.status = 'accepted';
    res.json(await updateMatch(m));
  } catch (e: any) {
    res.status(500).json({ error: 'match_consent_failed', detail: String(e?.message ?? e) });
  }
});

// POST /matches/:id/dismiss
router.post('/matches/:id/dismiss', async (req: Request, res: Response) => {
  try {
    const m = await getMatch(req.params.id);
    if (!m) return res.status(404).json({ error: 'match_not_found' });
    m.status = 'dismissed';
    res.json(await updateMatch(m));
  } catch (e: any) {
    res.status(500).json({ error: 'match_dismiss_failed', detail: String(e?.message ?? e) });
  }
});

// ── TALENT GRAPH ──

// GET /graph/path?from=&to= — shortest connection path (discovery)
router.get('/graph/path', async (req: Request, res: Response) => {
  try {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    if (!from || !to) return res.status(400).json({ error: 'from_and_to_required' });
    const { nodes, edges } = await loadGraphData();
    const g = buildGraph(nodes, edges);
    // minor protection: if the path target is a minor athlete without discovery grant,
    // do not reveal the path to an arbitrary caller (parity with search RLS posture).
    if (athleteIsMinor(to)) {
      return res.status(403).json({ error: 'minor_not_discoverable', detail: 'path to a minor athlete is gated by guardian consent' });
    }
    const path = g.shortestPath(from, to);
    if (!path) return res.json({ path: null, connected: false });
    res.json({ path, connected: true, degrees: path.length });
  } catch (e: any) {
    res.status(500).json({ error: 'graph_path_failed', detail: String(e?.message ?? e) });
  }
});

// GET /graph/connections?id=&type= — direct connections, optional type filter
router.get('/graph/connections', async (req: Request, res: Response) => {
  try {
    const id = String(req.query.id ?? '');
    const type = req.query.type as any;
    if (!id) return res.status(400).json({ error: 'id_required' });
    const { nodes, edges } = await loadGraphData();
    const g = buildGraph(nodes, edges);
    // exclude minor athletes from a generic connections listing (discovery protection)
    const conns = g.connections(id, type).filter((n) => !(n.type === 'athlete' && athleteIsMinor(n.id)));
    res.json({ id, count: conns.length, connections: conns });
  } catch (e: any) {
    res.status(500).json({ error: 'graph_connections_failed', detail: String(e?.message ?? e) });
  }
});

export default router;
