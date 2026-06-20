// CW12 — scorer authorization guard (open Q4, RLS-first).
// Score events mutate the data factory, so posting a ball must be gated to authorized
// roles. This guard reads the authenticated user's role_flags off the request (set by
// CW9's shared JWT-decode middleware once it's mounted on the gateway).
//
// SAFE-BY-DEFAULT POSTURE:
//   - SCORER_AUTH_ENFORCED unset/0  -> guard is INERT (open), so local/dev + tests pass.
//   - SCORER_AUTH_ENFORCED=1        -> guard enforces: req.auth.role_flags must intersect
//                                      ALLOWED_SCORER_ROLES, else 403.
// When CW9's middleware lands and DK sets SCORER_AUTH_ENFORCED=1 on the gateway, scoring
// locks down with no code change here. Until then nothing breaks.
//
// Roles allowed to post score events (pending manager confirmation of exact set):
//   league_admin, association_admin, academy_admin  (+ a future 'scorer' role if added)

import type { Request, Response, NextFunction } from 'express';

export const ALLOWED_SCORER_ROLES = [
  'league_admin',
  'association_admin',
  'academy_admin',
  'admin',
];

interface AuthedRequest extends Request {
  auth?: { user_id?: string; role_flags?: string[] };
}

export function requireScorer(req: AuthedRequest, res: Response, next: NextFunction): void {
  const enforced = process.env.SCORER_AUTH_ENFORCED === '1';
  if (!enforced) { next(); return; } // inert until CW9 middleware + DK flip

  const roles = req.auth?.role_flags ?? [];
  const ok = roles.some((r) => ALLOWED_SCORER_ROLES.includes(r));
  if (!ok) {
    res.status(403).json({
      error: 'not authorized to score this match',
      allowed: ALLOWED_SCORER_ROLES,
    });
    return;
  }
  next();
}
