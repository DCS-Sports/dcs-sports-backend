// src/middleware/auth.ts
// Verifies the Bearer JWT against Supabase Auth (getUser), then attaches a
// user-scoped client so every downstream read is RLS-enforced at the DB.
// RLS remains the authority for row visibility; this adds a clean 401 on
// invalid/expired tokens + a verified user_id for downstream use.
import { Request, Response, NextFunction } from 'express';
import { getUserScopedClient } from '../db/supabase';
import { SupabaseClient } from '@supabase/supabase-js';

export interface AuthedRequest extends Request {
  jwt?: string;
  userId?: string;
  db?: SupabaseClient;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing bearer token' });
  }
  const jwt = header.slice('Bearer '.length).trim();
  if (!jwt) return res.status(401).json({ error: 'empty token' });

  let userClient: SupabaseClient;
  try {
    userClient = getUserScopedClient(jwt);
  } catch {
    return res.status(503).json({ error: 'auth backend unconfigured' });
  }

  // Verify the token is a real, unexpired Supabase JWT.
  try {
    const { data, error } = await userClient.auth.getUser(jwt);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'invalid or expired token' });
    }
    req.userId = data.user.id;
  } catch {
    // If the auth service is unreachable, fail closed (401) rather than
    // letting an unverified token through.
    return res.status(401).json({ error: 'token verification failed' });
  }

  req.jwt = jwt;
  req.db = userClient; // RLS applies to this user
  next();
}

// Optional auth: attaches user if a valid token is present, else continues
// unauthenticated (for routes with public + private read tiers).
export async function optionalAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const jwt = header.slice(7).trim();
    try {
      const c = getUserScopedClient(jwt);
      const { data } = await c.auth.getUser(jwt);
      if (data?.user) { req.jwt = jwt; req.userId = data.user.id; req.db = c; }
    } catch { /* continue unauthenticated */ }
  }
  next();
}
