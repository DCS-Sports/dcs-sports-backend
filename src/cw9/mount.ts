// src/mount.ts
// PART A — CW9 as a gateway-mountable module (no separate server).
// CW16 calls mountCW9(app) on the single gateway Express app. This attaches:
//   • the auth middleware (real Supabase JWT verify; sets req.session)
//   • all CW9 identity/rights/ownership/org/kyc routes
// under an optional basePath, WITHOUT owning app.listen and WITHOUT touching
// the gateway's existing auth/passport/scoring routes.
//
// Contract for CW16:
//   import { mountCW9 } from "dcs-sports-cw9/mount";
//   mountCW9(app, { basePath: "/" });   // or "/identity" to namespace
//
// Idempotent + regression-safe: only registers CW9's own paths; never a
// catch-all 404/error handler (the gateway owns those), so mounting CW9 cannot
// swallow other lanes' routes.

import type { Express, Router as ExpressRouter } from "express";
import { authMiddleware } from "./middleware/auth";
import { identityRouter } from "./routes/identity";

export interface MountOptions {
  basePath?: string;          // default "/" (mount at root); use "/identity" to namespace
  installAuth?: boolean;      // default true; set false if the gateway already runs a compatible auth middleware that sets req.session
}

/** The list of path prefixes CW9 owns — for CW16's overlap reconciliation. */
export const CW9_ROUTE_PREFIXES = [
  "/auth", "/me", "/athletes", "/grants", "/access-requests",
  "/parent-links", "/consent-receipts", "/orgs", "/admin",
];

/** Mount CW9 onto the gateway app. Returns the router for further composition. */
export function mountCW9(app: Express, opts: MountOptions = {}): ExpressRouter {
  const basePath = opts.basePath ?? "/";
  const installAuth = opts.installAuth ?? true;

  // Auth middleware is per-request and only POPULATES req.session (never blocks);
  // mounting it path-scoped means it won't override a gateway-wide auth if present.
  if (installAuth) {
    if (basePath === "/") app.use(authMiddleware);
    else app.use(basePath, authMiddleware);
  }

  if (basePath === "/") app.use(identityRouter);
  else app.use(basePath, identityRouter);

  return identityRouter;
}

/** Convenience: also expose a health subpath the gateway can probe per-lane. */
export function cw9Health() {
  return { lane: "CW9-identity", mountable: true, owns: CW9_ROUTE_PREFIXES };
}
