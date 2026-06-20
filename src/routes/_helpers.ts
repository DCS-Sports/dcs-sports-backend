// src/routes/_helpers.ts
// Shared route helpers. Writes use service role; reads that must respect
// athlete visibility/minor-gating use the caller's JWT (RLS at the DB).
import { Response } from 'express';
import { getServiceClient, getUserScopedClient } from '../db/supabase';
import { AuthedRequest } from '../middleware/auth';

export function svc() {
  return getServiceClient();
}

/** RLS-scoped client from the request's bearer token. Falls back to a 401
 *  signal (null) if absent — caller decides whether the route requires auth. */
export function rls(req: AuthedRequest) {
  if (req.db) return req.db;
  if (req.jwt) return getUserScopedClient(req.jwt);
  return null;
}

export function ok(res: Response, data: unknown) {
  return res.json(data);
}

export function fail(res: Response, code: number, message: string) {
  return res.status(code).json({ error: message });
}

/** Wrap an async handler so thrown errors become clean 400/500s, never crash. */
export function h(fn: (req: AuthedRequest, res: Response) => Promise<unknown>) {
  return async (req: AuthedRequest, res: Response) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      const msg = e?.message ?? 'internal error';
      const code = /not set|unconfigured/i.test(msg) ? 503 : 400;
      res.status(code).json({ error: msg });
    }
  };
}
