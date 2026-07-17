// src/routes/match_db.ts
// Completes the League/Match scoring chain on the REAL database and exposes the
// fan/official read views from the SAME persisted data.
//
// Why this exists: routes/league.ts had POST /leagues, POST /matches/:id/score and
// standings — but no DB way to create teams or a match, and the scorecard/center/
// commentary endpoints only existed in the CW12 in-memory router. So scored balls
// wrote to Postgres while the views read from memory → the fan/official screens
// never showed real data. This router adds the missing DB pieces and is mounted
// BEFORE the CW12 additive router, so these paths resolve to the DB versions.
//
// Chain: POST /leagues (league.ts) → POST /leagues/:id/teams → POST /matches
//        → POST /matches/:id/score (league.ts) → GET scorecard | center | commentary.
import { Router } from 'express';
import { createHash } from 'crypto';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { svc, ok, fail, h } from './_helpers';
import { fuseMatch, disagreementQueue } from './fusion';

export const matchDbRouter = Router();

// GET /matches/:id/fusion — CW3 Assisted Scoring Fusion (READ-ONLY).
// Compares the scorer's ball stream with camera tracked-events → AGREE / DISAGREE /
// CAMERA_ONLY / SCORER_ONLY per delivery, plus the disagreement queue for officials.
// No writes, no autonomous scoring: resolution still goes through the human confirm/reject
// endpoint. This just surfaces where scorer and camera agree or need a human look.
matchDbRouter.get('/matches/:id/fusion', requireAuth, h(async (req: AuthedRequest, res) => {
  const s = svc();
  const [scorer, camera] = await Promise.all([
    s.from('sports_live_scores').select('match_id,innings,over,ball,event_json,ts').eq('match_id', req.params.id),
    s.from('sports_tracked_events').select('id,match_id,type,over,ball,athlete_id,confidence,estimate,data_json,created_at').eq('match_id', req.params.id),
  ]);
  const scorerRows = (scorer.data ?? []).map((r: any) => ({ match_id: r.match_id, innings: r.innings, over: r.over, ball: r.ball, event_json: r.event_json, ts: r.ts }));
  const cameraRows = (camera.data ?? []) as any[];
  const hashEvent = (e: any) => createHash('sha256').update(JSON.stringify(e, Object.keys(e || {}).sort())).digest('hex');
  const decisions = fuseMatch(scorerRows as any, cameraRows as any, hashEvent);
  return ok(res, { decisions, disagreements: disagreementQueue(decisions), counts: decisions.reduce((a: any, d: any) => { a[d.state] = (a[d.state] || 0) + 1; return a; }, {}) });
}));

// POST /leagues/:id/teams — add a team to a league
matchDbRouter.post('/leagues/:id/teams', requireAuth, h(async (req: AuthedRequest, res) => {
  const { name, academy_id } = req.body ?? {};
  if (!name) return fail(res, 400, 'name required');
  const { data, error } = await svc()
    .from('sports_teams')
    .insert({ league_id: req.params.id, name, academy_id: academy_id ?? null })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// POST /matches — create a match row (must exist before scoring)
matchDbRouter.post('/matches', requireAuth, h(async (req: AuthedRequest, res) => {
  const { league_id, type, home_team_id, away_team_id, venue, date } = req.body ?? {};
  if (!home_team_id || !away_team_id) return fail(res, 400, 'home_team_id and away_team_id required');
  const { data, error } = await svc()
    .from('sports_matches')
    .insert({
      league_id: league_id ?? null,
      type: type ?? 't20',
      home_team_id,
      away_team_id,
      venue: venue ?? null,
      date: date ?? new Date().toISOString().slice(0, 10), // default today (date may be NOT NULL)
      status: 'live',
      result: null,
    })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// GET /matches/:id/scorecard — batting/bowling aggregates for fans (from real performances)
matchDbRouter.get('/matches/:id/scorecard', requireAuth, h(async (req: AuthedRequest, res) => {
  const s = svc();
  const { data: match } = await s.from('sports_matches').select('*').eq('id', req.params.id).maybeSingle();
  const { data: perf, error } = await s
    .from('sports_match_performances')
    .select('athlete_id,runs,balls,fours,sixes,wickets,catches')
    .eq('match_id', req.params.id);
  if (error) return fail(res, 400, error.message);
  const rows = perf ?? [];
  const totals = rows.reduce(
    (a: any, r: any) => ({ runs: a.runs + (r.runs || 0), wickets: a.wickets + (r.wickets || 0), balls: a.balls + (r.balls || 0) }),
    { runs: 0, wickets: 0, balls: 0 }
  );
  return ok(res, { match: match ?? null, totals, batting: rows });
}));

// GET /matches/:id/center — live Match Center state (recent balls + performances)
matchDbRouter.get('/matches/:id/center', requireAuth, h(async (req: AuthedRequest, res) => {
  const s = svc();
  const { data: match } = await s.from('sports_matches').select('*').eq('id', req.params.id).maybeSingle();
  const { data: balls } = await s
    .from('sports_live_scores')
    .select('over,ball,event_json,ts')
    .eq('match_id', req.params.id)
    .order('ts', { ascending: false })
    .limit(12);
  const { data: perf } = await s
    .from('sports_match_performances')
    .select('athlete_id,runs,balls,fours,sixes,wickets')
    .eq('match_id', req.params.id);
  return ok(res, { match: match ?? null, recent: balls ?? [], performances: perf ?? [] });
}));

// POST /matches/:id/roster — set player names for a team (home|away)
matchDbRouter.post('/matches/:id/roster', requireAuth, h(async (req: AuthedRequest, res) => {
  const { team, players } = req.body ?? {};
  if (!team || !Array.isArray(players)) return fail(res, 400, 'team and players[] required');
  const rows = players.filter((p: any) => (p && (p.name || typeof p === 'string')))
    .map((p: any, i: number) => ({ match_id: req.params.id, team, name: (typeof p === 'string' ? p : p.name), batting_order: i + 1, athlete_id: (p && p.athlete_id) || null }));
  if (!rows.length) return fail(res, 400, 'no player names');
  const { error } = await svc().from('sports_match_players').insert(rows);
  if (error) return fail(res, 400, error.message);
  return ok(res, { added: rows.length });
}));

matchDbRouter.get('/matches/:id/roster', requireAuth, h(async (req: AuthedRequest, res) => {
  const { data, error } = await svc().from('sports_match_players').select('*').eq('match_id', req.params.id).order('batting_order', { ascending: true });
  if (error) return fail(res, 400, error.message);
  return ok(res, { players: data ?? [] });
}));

// POST /matches/:id/ball — RICH ball: striker, bowler, extras, wicket (stored in event_json).
matchDbRouter.post('/matches/:id/ball', requireAuth, h(async (req: AuthedRequest, res) => {
  const b = req.body ?? {};
  const innings = Number(b.innings || 1) === 2 ? 2 : 1;
  const ev = {
    kind: 'rich', innings, over: b.over ?? 0, ball: b.ball ?? 0,
    striker: b.striker ?? null, non_striker: b.non_striker ?? null, bowler: b.bowler ?? null,
    runs: Number(b.runs || 0),
    extra: b.extra && b.extra.type ? { type: b.extra.type, runs: Number(b.extra.runs || 0) } : null,
    wicket: b.wicket ? { how: b.wicket.how || 'out', out: b.wicket.out || (b.striker && b.striker.name) || null, fielder: b.wicket.fielder || null } : null,
    // wagon-wheel: shot direction 0-7 (0=fine leg, clockwise for RHB) — manual from console or from tracking
    shot: (b.shot && b.shot.dir != null) ? { dir: Math.max(0, Math.min(7, Number(b.shot.dir))) } : null,
    // pitch map / beehive: filled by tracking (single-cam CV or provider) — line/length as normalized x,y
    pitch: (b.pitch && b.pitch.x != null) ? { x: Number(b.pitch.x), y: Number(b.pitch.y) } : null,
    ts: new Date().toISOString(),
  };
  const legal = !ev.extra || (ev.extra.type !== 'wd' && ev.extra.type !== 'nb');
  const { error } = await svc().from('sports_live_scores').insert({ match_id: req.params.id, innings, over: ev.over, ball: ev.ball, event_json: ev, ts: ev.ts });
  if (error) return fail(res, 400, error.message);
  if (ev.striker && ev.striker.id) {
    const { data: ex } = await svc().from('sports_match_performances').select('*').eq('match_id', req.params.id).eq('athlete_id', ev.striker.id).maybeSingle();
    const base: any = ex || { runs: 0, balls: 0, fours: 0, sixes: 0, wickets: 0 };
    await svc().from('sports_match_performances').upsert({
      match_id: req.params.id, athlete_id: ev.striker.id,
      runs: (base.runs || 0) + ev.runs, balls: (base.balls || 0) + (legal ? 1 : 0),
      fours: (base.fours || 0) + (ev.runs === 4 ? 1 : 0), sixes: (base.sixes || 0) + (ev.runs === 6 ? 1 : 0),
      wickets: base.wickets || 0, source: 'match',
    }, { onConflict: 'match_id,athlete_id' });
  }
  return ok(res, { recorded: ev });
}));

// POST /public/claims — PUBLIC lead capture from the fan scorecard ("this is me").
// No auth: a viewer/player claims a name; the org follows up. Light validation, no PII in URLs.
matchDbRouter.post('/public/claims', h(async (req: AuthedRequest, res) => {
  const b = req.body ?? {};
  const player_name = String(b.player_name || '').trim().slice(0, 120);
  if (!player_name) return fail(res, 400, 'player_name required');
  const email = b.email ? String(b.email).trim().slice(0, 160) : null;
  const contact = b.contact ? String(b.contact).trim().slice(0, 120) : null;
  if (!email && !contact) return fail(res, 400, 'an email or contact is required');
  const row = { match_id: b.match_id || null, player_name, email, contact, note: b.note ? String(b.note).slice(0, 300) : null, status: 'new' };
  const { error } = await svc().from('sports_player_claims').insert(row);
  if (error) return fail(res, 400, error.message);
  // fire-and-forget notification — only if an email provider is configured (Resend).
  // The claim is already saved; email failure never affects the response.
  if (process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL) {
    const esc = (v: any) => String(v ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as any)[c]);
    const html = `<p>A player claimed their profile from a DCS Sports scorecard.</p>`
      + `<ul><li><b>Name:</b> ${esc(player_name)}</li>`
      + `<li><b>Contact:</b> ${esc(email || contact)}</li>`
      + `<li><b>Match:</b> ${esc(row.match_id || '—')}</li></ul>`
      + `<p>Review all claims in the dashboard → Admin → Player claims.</p>`;
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || 'DCS Sports <onboarding@resend.dev>',
        to: process.env.NOTIFY_EMAIL, subject: `New player claim: ${player_name}`, html,
      }),
    }).catch(() => { /* notification is best-effort */ });
  }
  return ok(res, { received: true });
}));

// GET /public/leaderboard — network Talent Index: top run-scorers + wicket-takers,
// aggregated across every match's rich ball data (by player name). Public.
matchDbRouter.get('/public/leaderboard', h(async (req: AuthedRequest, res) => {
  const { data } = await svc().from('sports_live_scores').select('event_json').order('ts', { ascending: false }).limit(6000);
  const bat: Record<string, any> = {}; const bowl: Record<string, any> = {};
  (data ?? []).forEach((r: any) => {
    const e = r.event_json || {}; if (e.kind !== 'rich') return;
    const sn = e.striker && e.striker.name; const bn = e.bowler && e.bowler.name;
    const ro = Number(e.runs || 0); const ex = e.extra; const legal = !ex || (ex.type !== 'wd' && ex.type !== 'nb');
    if (sn && sn !== 'Batter') { const m = bat[sn] || (bat[sn] = { name: sn, runs: 0, balls: 0, fours: 0, sixes: 0 }); m.runs += ro; if (legal) m.balls += 1; if (ro === 4) m.fours += 1; if (ro === 6) m.sixes += 1; }
    if (bn) { const m = bowl[bn] || (bowl[bn] = { name: bn, balls: 0, runs: 0, wickets: 0 }); if (legal) m.balls += 1; m.runs += ro + (ex ? ex.runs : 0); if (e.wicket && ['bowled', 'caught', 'lbw', 'stumped'].includes(e.wicket.how)) m.wickets += 1; }
  });
  const batting = Object.values(bat).sort((a: any, b: any) => b.runs - a.runs).slice(0, 20).map((x: any) => ({ ...x, sr: x.balls ? ((x.runs / x.balls) * 100).toFixed(1) : '0.0' }));
  const bowling = Object.values(bowl).sort((a: any, b: any) => (b.wickets - a.wickets) || (a.runs - b.runs)).slice(0, 20).map((x: any) => ({ ...x, overs: Math.floor(x.balls / 6) + '.' + (x.balls % 6), econ: x.balls ? (x.runs / (x.balls / 6)).toFixed(2) : '0.00' }));
  return ok(res, { batting, bowling });
}));

// GET /claims — org review queue (admin/league/scout). Newest first.
matchDbRouter.get('/claims', requireAuth, h(async (req: AuthedRequest, res) => {
  const { data, error } = await svc().from('sports_player_claims').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) return fail(res, 400, error.message);
  return ok(res, { claims: data ?? [] });
}));

// GET /public/matches/:id — PUBLIC fan view. Builds full batting/bowling cards, fall of
// wickets, extras and over-by-over from the rich ball timeline (falls back for simple balls).
matchDbRouter.get('/public/matches/:id', h(async (req: AuthedRequest, res) => {
  const s = svc();
  const { data: match } = await s.from('sports_matches').select('*').eq('id', req.params.id).maybeSingle();
  if (!match) return fail(res, 404, 'match not found');
  const { data: ballsAsc } = await s.from('sports_live_scores').select('over,ball,event_json,ts').eq('match_id', req.params.id).order('ts', { ascending: true }).limit(900);
  const allEvents = (ballsAsc ?? []).map((r: any) => r.event_json || {});
  // ── compute one innings' full card set from its ball stream ──
  const computeInnings = (events: any[]) => {
    const batOrder: string[] = []; const bat: Record<string, any> = {}; const bowl: Record<string, any> = {};
    const fow: any[] = []; const extras: any = { wd: 0, nb: 0, b: 0, lb: 0, total: 0 };
    let runs = 0, wkts = 0, legalBalls = 0; const balls: any[] = []; const commentary: any[] = [];
    for (const e of events) {
      const rich = e.kind === 'rich';
      const strikerName = rich ? ((e.striker && e.striker.name) || 'Batter') : ('Player ' + String(e.athlete_id || '').slice(0, 8));
      const bowlerName = rich ? ((e.bowler && e.bowler.name) || null) : null;
      const runOff = Number(e.runs || 0);
      const ex = rich ? e.extra : null;
      const isWkt = rich ? !!e.wicket : e.event === 'wicket';
      const legal = !ex || (ex.type !== 'wd' && ex.type !== 'nb');
      if (!bat[strikerName]) { bat[strikerName] = { name: strikerName, runs: 0, balls: 0, fours: 0, sixes: 0, out: false, dismissal: 'not out' }; batOrder.push(strikerName); }
      bat[strikerName].runs += runOff; if (legal) bat[strikerName].balls += 1;
      if (runOff === 4) bat[strikerName].fours += 1; if (runOff === 6) bat[strikerName].sixes += 1;
      if (bowlerName) { if (!bowl[bowlerName]) bowl[bowlerName] = { name: bowlerName, balls: 0, runs: 0, wickets: 0 }; if (legal) bowl[bowlerName].balls += 1; bowl[bowlerName].runs += runOff + (ex ? ex.runs : 0); }
      if (ex && ex.type && extras[ex.type] != null) { extras[ex.type] += ex.runs; extras.total += ex.runs; }
      runs += runOff + (ex ? ex.runs : 0); if (legal) legalBalls += 1;
      if (isWkt) {
        wkts += 1;
        const outName = rich ? ((e.wicket && e.wicket.out) || strikerName) : strikerName;
        if (bat[outName]) { bat[outName].out = true; bat[outName].dismissal = rich ? (e.wicket.how + (e.wicket.fielder ? ' ' + e.wicket.fielder : '') + (bowlerName ? ' b ' + bowlerName : '')) : 'out'; }
        if (bowlerName && rich && ['bowled', 'caught', 'lbw', 'stumped'].includes(e.wicket.how)) bowl[bowlerName].wickets += 1;
        fow.push({ wkt: wkts, score: runs, at: e.over + '.' + e.ball, who: outName });
      }
      balls.push({ over: e.over, ball: e.ball, event: isWkt ? 'wicket' : 'run', runs: runOff, extra: ex ? ex.type : null, shot: e.shot ?? null, pitch: e.pitch ?? null });
      const label = isWkt ? ('WICKET — ' + (rich ? e.wicket.how : 'out')) : (ex ? (String(ex.type).toUpperCase() + ' ' + ex.runs + (runOff ? ' +' + runOff : '')) : (runOff + ' run' + (runOff === 1 ? '' : 's')));
      commentary.unshift({ over: e.over, ball: e.ball, event: isWkt ? 'wicket' : 'run', runs: runOff, text: `${e.over}.${e.ball} — ${strikerName}${bowlerName ? ' (b ' + bowlerName + ')' : ''}: ${label}`, ts: e.ts });
    }
    const batting = batOrder.map((n) => bat[n]);
    const bowling = Object.values(bowl).map((x: any) => ({ ...x, overs: Math.floor(x.balls / 6) + '.' + (x.balls % 6), econ: x.balls ? (x.runs / (x.balls / 6)).toFixed(2) : '0.00' }));
    return { totals: { runs, wickets: wkts, balls: legalBalls }, batting, bowling, fow, extras, balls, commentary: commentary.slice(0, 80) };
  };
  const ev1 = allEvents.filter((e: any) => (Number(e.innings) || 1) === 1);
  const ev2 = allEvents.filter((e: any) => Number(e.innings) === 2);
  const inn1 = computeInnings(ev1);
  const inn2 = ev2.length ? computeInnings(ev2) : null;
  const live = inn2 || inn1;                 // the innings currently in progress
  const totalBalls = ({ t20: 120, t10: 60, odi: 300, '50': 300, '20': 120 } as any)[String(match.type || 't20').toLowerCase()] || 120;
  // target / required run rate / result — only meaningful once a chase is on
  let target: number | null = null, chase: any = null, result: string | null = null;
  if (inn2) {
    target = inn1.totals.runs + 1;
    const need = target - inn2.totals.runs;
    const ballsLeft = Math.max(0, totalBalls - inn2.totals.balls);
    chase = { target, need: Math.max(0, need), ballsLeft, rrr: ballsLeft > 0 ? (need / (ballsLeft / 6)).toFixed(2) : '—' };
  }
  const done = match.status === 'completed';
  if (done) {
    if (inn2 && inn2.totals.runs >= (inn1.totals.runs + 1)) result = 'Chasing side won by ' + (10 - inn2.totals.wickets) + ' wkt' + ((10 - inn2.totals.wickets) === 1 ? '' : 's');
    else if (inn2) { const by = inn1.totals.runs - inn2.totals.runs; result = by > 0 ? 'Defending side won by ' + by + ' run' + (by === 1 ? '' : 's') : (by === 0 ? 'Match tied' : ''); }
  }
  // ── player of the match: batting + bowling impact across both innings ──
  const potmMap: Record<string, any> = {};
  const addBat = (arr: any[]) => (arr || []).forEach((b: any) => { const m = potmMap[b.name] || (potmMap[b.name] = { name: b.name, runs: 0, balls: 0, fours: 0, sixes: 0, wkts: 0 }); m.runs += b.runs || 0; m.balls += b.balls || 0; m.fours += b.fours || 0; m.sixes += b.sixes || 0; });
  const addBowl = (arr: any[]) => (arr || []).forEach((b: any) => { const m = potmMap[b.name] || (potmMap[b.name] = { name: b.name, runs: 0, balls: 0, fours: 0, sixes: 0, wkts: 0 }); m.wkts += b.wickets || 0; });
  addBat(inn1.batting); addBowl(inn1.bowling); if (inn2) { addBat(inn2.batting); addBowl(inn2.bowling); }
  let potm: any = null; let bestScore = -1;
  for (const k in potmMap) { const m = potmMap[k]; if (m.name === 'Batter' || m.name === 'Unknown') continue; const sc = m.runs + m.wkts * 25 + m.sixes * 2 + m.fours; if (sc > bestScore && (m.runs > 0 || m.wkts > 0)) { bestScore = sc; potm = m; } }
  let potmOut: any = null;
  if (potm) { const parts: string[] = []; if (potm.runs > 0 || potm.balls > 0) parts.push(potm.runs + ' (' + potm.balls + ')'); if (potm.wkts > 0) parts.push(potm.wkts + ' wkt' + (potm.wkts > 1 ? 's' : '')); potmOut = { name: potm.name, line: parts.join(' & ') }; }
  const tids = [match.home_team_id, match.away_team_id].filter(Boolean);
  const teams: Record<string, string> = {};
  if (tids.length) { const { data: tm } = await s.from('sports_teams').select('id,name').in('id', tids); (tm ?? []).forEach((t: any) => { teams[t.id] = t.name; }); }
  let league: string | null = null;
  if (match.league_id) { const { data: lg } = await s.from('sports_leagues').select('name').eq('id', match.league_id).maybeSingle(); league = (lg && lg.name) || null; }
  const { data: hlRaw } = await s.from('sports_tracked_events').select('type,over,ball,confidence,estimate,data_json').eq('match_id', req.params.id).in('type', ['four', 'six', 'boundary', 'wicket', 'catch']).order('created_at', { ascending: false }).limit(20);
  const hl = (hlRaw ?? []).map((x: any) => ({ type: x.type, over: x.over, ball: x.ball, confidence: x.confidence, estimate: x.estimate, resolved: (x.data_json && x.data_json.resolved) || null, resolved_by: (x.data_json && x.data_json.resolved_by) || null }));
  return ok(res, {
    match, league, home: teams[match.home_team_id] || 'Home', away: teams[match.away_team_id] || 'Away',
    // flat fields = the live innings (backward compatible with existing UI)
    totals: live.totals, batting: live.batting, bowling: live.bowling, fow: live.fow, extras: live.extras,
    balls: live.balls, commentary: live.commentary,
    // new: both innings + chase context
    inningsNo: inn2 ? 2 : 1, innings1: inn1, innings2: inn2, chase, target, result, totalBalls,
    potm: potmOut, highlights: hl ?? [],
  });
}));

// GET /matches/:id/commentary — ball-by-ball feed rendered as commentary lines
matchDbRouter.get('/matches/:id/commentary', requireAuth, h(async (req: AuthedRequest, res) => {
  const { data, error } = await svc()
    .from('sports_live_scores')
    .select('over,ball,event_json,ts')
    .eq('match_id', req.params.id)
    .order('ts', { ascending: false })
    .limit(80);
  if (error) return fail(res, 400, error.message);
  const commentary = (data ?? []).map((b: any) => {
    const e = b.event_json || {};
    const runs = e.runs != null ? ` (${e.runs} run${e.runs === 1 ? '' : 's'})` : '';
    return { over: b.over, ball: b.ball, text: `${b.over}.${b.ball} — ${e.event || 'ball'}${runs}`, ts: b.ts };
  });
  return ok(res, { commentary });
}));

// ── Smart-camera / DRS layer (estimate-labeled, honest) ──

// POST /matches/:id/tracked-events — smart-camera posts tracked events (boundary/catch/etc).
// Every tracked output is estimate:true with a confidence — never presented as ground truth.
matchDbRouter.post('/matches/:id/tracked-events', requireAuth, h(async (req: AuthedRequest, res) => {
  const events: any[] = Array.isArray(req.body?.events) ? req.body.events : [];
  if (!events.length) return fail(res, 400, 'events[] required');
  const rows = events.map((e) => ({
    match_id: req.params.id,
    type: e.type ?? 'event',
    over: e.over ?? 0,
    ball: e.ball ?? 0,
    athlete_id: e.athlete_id ?? null,
    confidence: e.confidence ?? null,
    estimate: true,
    data_json: e,
  }));
  const { data, error } = await svc().from('sports_tracked_events').insert(rows).select();
  if (error) return fail(res, 400, error.message);
  return ok(res, { ingested: (data ?? []).length, tracked: data ?? [] });
}));

// GET /matches/:id/event-center — officials' feed: scored balls + tracked/DRS events
matchDbRouter.get('/matches/:id/event-center', requireAuth, h(async (req: AuthedRequest, res) => {
  const s = svc();
  const [balls, tracked] = await Promise.all([
    s.from('sports_live_scores').select('over,ball,event_json,ts').eq('match_id', req.params.id).order('ts', { ascending: false }).limit(40),
    s.from('sports_tracked_events').select('id,type,over,ball,confidence,estimate,data_json,created_at').eq('match_id', req.params.id).order('created_at', { ascending: false }).limit(40),
  ]);
  return ok(res, { balls: balls.data ?? [], tracked: tracked.data ?? [] });
}));

// POST /matches/:id/tracked-events/:eid/resolve — human-in-the-loop official decision.
// The camera output is an ESTIMATE; an official CONFIRMS (→ becomes an official ball on the
// scorecard, estimate flips to false) or REJECTS (→ removed). This is the DRS/AI-umpire rule.
matchDbRouter.post('/matches/:id/tracked-events/:eid/resolve', requireAuth, h(async (req: AuthedRequest, res) => {
  const s = svc();
  const action = String(req.body?.action || '').toLowerCase();
  const { data: te } = await s.from('sports_tracked_events').select('*').eq('id', req.params.eid).maybeSingle();
  if (!te) return fail(res, 404, 'tracked event not found');
  if (action === 'reject') {
    const j = { ...(te.data_json || {}), resolved: 'rejected', resolved_by: req.userId, resolved_at: new Date().toISOString() };
    await s.from('sports_tracked_events').update({ estimate: false, data_json: j }).eq('id', te.id);
    return ok(res, { resolved: 'rejected' });
  }
  if (action !== 'confirm') return fail(res, 400, 'action must be confirm or reject');
  // map the camera event type → a scoring outcome
  const t = String(te.type || '').toLowerCase();
  const runsByType: any = { four: 4, boundary: 4, six: 6 };
  const isWkt = t === 'wicket' || t === 'catch' || t === 'bowled' || t === 'lbw';
  const innings = Number(req.body?.innings || 1) === 2 ? 2 : 1;
  const striker = req.body?.striker ? { name: String(req.body.striker) } : null;
  const bowler = req.body?.bowler ? { name: String(req.body.bowler) } : null;
  const ev: any = {
    kind: 'rich', innings, over: te.over ?? 0, ball: te.ball ?? 0,
    striker, non_striker: null, bowler,
    runs: isWkt ? 0 : (runsByType[t] ?? 0),
    extra: null,
    wicket: isWkt ? { how: t === 'catch' ? 'caught' : (t === 'wicket' ? 'bowled' : t), out: striker ? striker.name : null, fielder: req.body?.fielder || null } : null,
    ts: new Date().toISOString(), from_camera: true,
  };
  await s.from('sports_live_scores').insert({ match_id: req.params.id, innings, over: ev.over, ball: ev.ball, event_json: ev, ts: ev.ts });
  const j = { ...(te.data_json || {}), resolved: 'confirmed', resolved_by: req.userId, resolved_at: new Date().toISOString() };
  await s.from('sports_tracked_events').update({ estimate: false, data_json: j }).eq('id', te.id);
  return ok(res, { resolved: 'confirmed', scored: ev });
}));

// GET /matches/:id/broadcast — fan broadcast: match + totals + auto-highlights (tracked)
matchDbRouter.get('/matches/:id/broadcast', requireAuth, h(async (req: AuthedRequest, res) => {
  const s = svc();
  const { data: match } = await s.from('sports_matches').select('*').eq('id', req.params.id).maybeSingle();
  const { data: perf } = await s.from('sports_match_performances').select('runs,wickets,balls').eq('match_id', req.params.id);
  const totals = (perf ?? []).reduce(
    (a: any, r: any) => ({ runs: a.runs + (r.runs || 0), wickets: a.wickets + (r.wickets || 0), balls: a.balls + (r.balls || 0) }),
    { runs: 0, wickets: 0, balls: 0 }
  );
  const { data: highlights } = await s
    .from('sports_tracked_events')
    .select('type,over,ball,confidence,estimate')
    .eq('match_id', req.params.id)
    .in('type', ['four', 'six', 'boundary', 'wicket', 'catch'])
    .order('created_at', { ascending: false })
    .limit(20);
  return ok(res, { match: match ?? null, totals, highlights: highlights ?? [] });
}));

// ── League management ──

// GET /leagues — leagues the caller organizes
matchDbRouter.get('/leagues', requireAuth, h(async (req: AuthedRequest, res) => {
  const { data, error } = await svc()
    .from('sports_leagues').select('*').eq('organizer_user_id', req.userId)
    .order('created_at', { ascending: false });
  if (error) return fail(res, 400, error.message);
  return ok(res, { leagues: data ?? [] });
}));

// GET /leagues/:id/matches — matches in a league
matchDbRouter.get('/leagues/:id/matches', requireAuth, h(async (req: AuthedRequest, res) => {
  const { data, error } = await svc()
    .from('sports_matches').select('*').eq('league_id', req.params.id)
    .order('date', { ascending: false });
  if (error) return fail(res, 400, error.message);
  return ok(res, { matches: data ?? [] });
}));

// POST /matches/:id/close — mark a match completed with a result
matchDbRouter.post('/matches/:id/close', requireAuth, h(async (req: AuthedRequest, res) => {
  const { result } = req.body ?? {};
  const { data, error } = await svc()
    .from('sports_matches').update({ status: 'completed', result: result ?? 'completed' })
    .eq('id', req.params.id).select().single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// GET /selector/board — selection intelligence: athletes ranked by REAL aggregated
// match performance. Grounded in verified data (not an AI estimate).
matchDbRouter.get('/selector/board', requireAuth, h(async (req: AuthedRequest, res) => {
  const s = svc();
  const { data: perf, error } = await s
    .from('sports_match_performances').select('athlete_id,runs,wickets,balls');
  if (error) return fail(res, 400, error.message);
  const agg: Record<string, any> = {};
  (perf ?? []).forEach((r: any) => {
    const a = agg[r.athlete_id] || (agg[r.athlete_id] = { athlete_id: r.athlete_id, runs: 0, wickets: 0, balls: 0, innings: 0 });
    a.runs += r.runs || 0; a.wickets += r.wickets || 0; a.balls += r.balls || 0; a.innings += 1;
  });
  const sport = (req.query?.sport as string) || '';
  let rows = Object.values(agg).sort((a: any, b: any) => (b.runs - a.runs) || (b.wickets - a.wickets)).slice(0, 25);
  const ids = rows.map((r: any) => r.athlete_id);
  if (ids.length) {
    const { data: ath } = await s.from('sports_athletes').select('id,sport,role,state,district,verified_status').in('id', ids);
    const map: Record<string, any> = {};
    (ath ?? []).forEach((a: any) => { map[a.id] = a; });
    rows.forEach((r: any) => Object.assign(r, map[r.athlete_id] || {}));
    if (sport) rows = rows.filter((r: any) => r.sport === sport);
  }
  return ok(res, { board: rows });
}));

// ── Recovery OS — injury / workload / readiness log (athlete-scoped) ──
matchDbRouter.post('/athletes/:id/recovery', requireAuth, h(async (req: AuthedRequest, res) => {
  const { type, status, note, workload, readiness } = req.body ?? {};
  const { data, error } = await svc()
    .from('sports_recovery')
    .insert({ athlete_id: req.params.id, type: type ?? 'note', status: status ?? null, note: note ?? null, workload: workload ?? null, readiness: readiness ?? null })
    .select().single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

matchDbRouter.get('/athletes/:id/recovery', requireAuth, h(async (req: AuthedRequest, res) => {
  const { data, error } = await svc()
    .from('sports_recovery').select('*').eq('athlete_id', req.params.id)
    .order('created_at', { ascending: false }).limit(50);
  if (error) return fail(res, 400, error.message);
  return ok(res, { logs: data ?? [] });
}));
