// CW12 — gateway mount adapter (reconciliation-aware, v3.0 handover).
//
// The live gateway already mounts CW12's core league router + O(1) ball-by-ball scoring.
// Per the handover: "Reconcile your routes with the gateway league router — preserve the
// O(1) scoring that's live — deliver the smart-camera + broadcast endpoints as a mount."
//
// TWO MOUNT MODES for CW16 to choose:
//
//   1) ADDITIVE (recommended for the live gateway) — mounts ONLY net-new v3.0 routes
//      (smart-camera, broadcast, share, highlights, rankings, certificates, form, /sports).
//      Does NOT touch /matches/:id/score — the live O(1) scoring path is preserved.
//
//        import { mountCW12Additive } from '@dcs-sports/cw12-league-os';
//        mountCW12Additive(app);
//
//   2) FULL (for a fresh gateway with no league routes yet) — mounts the entire CW12
//      league router (scoring + everything). Use only if CW12 isn't already live.
//
//        import { mountLeagueOS } from '@dcs-sports/cw12-league-os';
//        mountLeagueOS(app);
//
// Both use the repo layer → live Supabase from the gateway's env (SUPABASE_URL + SERVICE_ROLE_KEY).

import type { Express, Router } from 'express';
import { leagueRouter } from './routes/league';
import { additiveRouter, ADDITIVE_ROUTES } from './routes/additive';

export { leagueRouter, additiveRouter, ADDITIVE_ROUTES };

/** ADDITIVE mount — v3.0 net-new routes only. Preserves the live O(1) scoring path. */
export function mountCW12Additive(app: Express, basePath = '/'): Router {
  app.use(basePath, additiveRouter);
  return additiveRouter;
}

/** FULL mount — entire CW12 league router (only for a gateway without CW12 league routes). */
export function mountLeagueOS(app: Express, basePath = '/'): Router {
  app.use(basePath, leagueRouter);
  return leagueRouter;
}

/** The route paths CW12's additive router owns — for CW16 collision/reconciliation checks. */
export function additiveRouteList(): string[] {
  return [...ADDITIVE_ROUTES];
}
