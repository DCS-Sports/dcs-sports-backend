// src/middleware/admin.ts
// Guards ops/selfcheck endpoints with a server-only admin token. Distinct from
// user auth: this is for DK/CI to run privileged probes, not for end users.
// Fail-closed: if SPORTS_ADMIN_TOKEN is unset, the route is unavailable (503),
// never open.
import { Request, Response, NextFunction } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.SPORTS_ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'admin ops disabled — SPORTS_ADMIN_TOKEN not set' });
  }
  const header = req.headers['x-admin-token'];
  if (typeof header !== 'string' || header !== expected) {
    return res.status(403).json({ error: 'admin token required' });
  }
  next();
}
