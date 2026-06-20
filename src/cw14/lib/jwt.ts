// CW14 · extract caller JWT from Authorization header for RLS-scoped reads.
import { Request } from 'express';
export function callerJwt(req: Request): string | undefined {
  const h = req.header('authorization') ?? req.header('Authorization');
  if (!h) return undefined;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : undefined;
}
