// CW13 — request identity. Prefers a real Supabase JWT (Authorization: Bearer
// <jwt>) once CW9's Auth is live; falls back to the x-user-id header for Day-0
// and local/standalone runs.
//
// CW9 owns auth. This module does NOT mint or fully validate tokens — the
// gateway's requireAuth (CW9) validates the JWT signature upstream and may
// attach req.user. Here we only READ the caller's id for CW13's human-action
// records, in priority order:
//   1. req.user?.id            (set by CW9's requireAuth after JWT validation)
//   2. Authorization: Bearer   (decode the JWT `sub` claim — read-only)
//   3. x-user-id header        (Day-0 / local fallback)
//
// We never trust the JWT for authorization decisions here (that's CW9/RLS); we
// only use it to attribute the human action (verified_by / decided_by).

import type { Request } from 'express';

export function callerId(req: Request): string {
  // 1 — CW9 requireAuth attached the user
  const fromUser = (req as any).user?.id;
  if (typeof fromUser === 'string' && fromUser) return fromUser;

  // 2 — decode JWT sub (read-only; signature already checked upstream)
  const auth = req.header('authorization') || req.header('Authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    const sub = subFromJwt(auth.slice(7).trim());
    if (sub) return sub;
  }

  // 3 — Day-0 / local fallback
  return (req.header('x-user-id') || '').trim();
}

// Decode (not verify) a JWT and return its `sub`. Signature verification is
// CW9's job at the gateway; this is purely to attribute the action.
function subFromJwt(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const sub = payload?.sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
}
