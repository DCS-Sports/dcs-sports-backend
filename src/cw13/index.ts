// CW13 — gateway integration point. CW16 mounts the whole lane with one call.
//
// CLEAN MOUNT (v3.0/v4.0 integration): the lane is a single Express Router with
// NO app.listen and NO global middleware — it only owns its own paths. CW16 can:
//
//   registerCw13Routes(app)                  // bare: routes at /verify/*, /badge/* …
//   registerCw13Routes(app, '/verification') // prefixed: /verification/verify/* …
//   app.use('/verification', cw13Router)      // or mount the router directly
//
// COLLISION NOTE (reconciling overlap per the integration mandate): several lane
// paths are intentionally generic within CW13's surface — `/metrics`, `/inbox`,
// `/squads`, `/badge`, `/reputation`. If another lane or the gateway already owns
// any of these at the top level, mount CW13 UNDER A PREFIX (recommended:
// '/verification') so every path is namespaced and nothing is regressed. CW13
// never defines `/`, `/health`, `/me`, `/auth/*`, passport, or scoring routes, so
// the working auth/passport/O(1)-scoring surface is never touched.

import type { Express, Router as ExpressRouter } from 'express';
import { router } from './routes/verify';
import { wireAtlasSigner, type AtlasSigner } from './lib/atlas-sign';

export function registerCw13Routes(app: Express, prefix?: string): void {
  if (prefix && prefix !== '/') app.use(prefix, router);
  else app.use(router);
}

// Re-export so CW16 can inject the real Atlas signer at gateway boot
// (badge issuance stays fail-closed until this is called).
export { wireAtlasSigner };
export type { AtlasSigner };
export const cw13Router: ExpressRouter = router;

// The generic-within-lane paths CW16 should check for collisions before a bare
// mount. If any clash, mount under a prefix instead (see note above).
export const CW13_GENERIC_PATHS = ['/metrics', '/inbox', '/squads', '/badge', '/reputation'] as const;
