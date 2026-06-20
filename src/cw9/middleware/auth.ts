// src/middleware/auth.ts
// CW9 · DCS Sports Identity — REAL Supabase Auth.
//
// Supabase issues HS256 JWTs signed with the project JWT secret. We verify the
// signature with SUPABASE_JWT_SECRET and trust only `sub` (user uuid) for
// identity — role_flags always come from the DB, never the token. For every
// authed DB query the handler runs set_config('request.jwt.claim.sub', sub, true)
// inside the transaction (lib/db.ts) so RLS sees the caller.
//
// Offline/dev (no SUPABASE_JWT_SECRET): accept the mock alg:none tokens the mock
// /auth issues, so `npm test` runs without a live project. Production MUST set
// SUPABASE_JWT_SECRET, at which point unsigned tokens are rejected.

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface SessionClaims {
  sub: string | null;
  email?: string | null;
  verified: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { session?: SessionClaims; }
  }
}

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || "";

function decodeUnverified(token: string): { sub: string | null; email?: string | null } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { sub: null };
    const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return { sub: typeof p.sub === "string" ? p.sub : null, email: p.email ?? null };
  } catch { return { sub: null }; }
}

export function verifySupabaseToken(token: string): SessionClaims | null {
  if (!JWT_SECRET) {
    const d = decodeUnverified(token);
    return d.sub ? { sub: d.sub, email: d.email ?? null, verified: false } : null;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as any;
    return { sub: payload.sub ?? null, email: payload.email ?? null, verified: true };
  } catch {
    return null;
  }
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const hdr = req.header("authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  req.session = token ? (verifySupabaseToken(token) ?? { sub: null, verified: false }) : { sub: null, verified: false };
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.sub) return res.status(401).json({ error: "unauthenticated" });
  next();
}

export function authIsLive(): boolean { return Boolean(JWT_SECRET); }
