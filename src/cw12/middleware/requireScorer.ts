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
import { getUserScopedClient, getServiceClient } from '../../db/supabase';

export const ALLOWED_SCORER_ROLES = [
  'league_admin',
  'association_admin',
  'academy_admin',
  'admin',
];

interface AuthedRequest extends Request {
  auth?: { user_id?: string; role_flags?: string[] };
}

export async function requireScorer(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const enforced = process.env.SCORER_AUTH_ENFORCED === '1';
  if (!enforced) { next(); return; } // inert until DK flips SCORER_AUTH_ENFORCED=1

  /* 🔴 SELF-CONTAINED.   15 Jul 2026
   * This used to read req.auth?.role_flags — but NOTHING populated req.auth (the "CW9 middleware"
   * in the comment never landed, and these routes mount requireScorer WITHOUT requireAuth before
   * it). So the moment SCORER_AUTH_ENFORCED=1, roles was always [] and scoring 403'd EVERYONE,
   * admin included. It now verifies the Bearer JWT itself and loads role_flags from sports_users. */
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing bearer token — sign in to score' });
    return;
  }
  const jwt = header.slice('Bearer '.length).trim();
  try {
    const { data, error } = await getUserScopedClient(jwt).auth.getUser(jwt);
    if (error || !data?.user) { res.status(401).json({ error: 'invalid or expired token' }); return; }
    const userId = data.user.id;

    const { data: row } = await getServiceClient()
      .from('sports_users').select('role_flags').eq('id', userId).maybeSingle();
    const roles: string[] = (row?.role_flags as string[] | undefined) ?? [];
    const ok = roles.some((r) => ALLOWED_SCORER_ROLES.includes(r));
    if (!ok) {
      res.status(403).json({
        error: 'not authorized to score this match',
        allowed: ALLOWED_SCORER_ROLES,
        your_roles: roles,   // honest: tells the scorer exactly what they have vs need
      });
      return;
    }
    req.auth = { user_id: userId, role_flags: roles };
    next();
  } catch {
    res.status(401).json({ error: 'auth verification failed' });
  }
}
