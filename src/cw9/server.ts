// src/server.ts — CW9 Identity service
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { authMiddleware, authIsLive } from "./middleware/auth";
import { mountCW9 } from "./mount";
import { LIVE } from "./lib/db";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  // JSON body with a sane limit; malformed bodies are caught below, not crashed.
  app.use(express.json({ limit: "256kb" }));
  // body-parser errors (malformed JSON, too large) -> clean 400, no stack trace.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err && (err.type === "entity.parse.failed" || err.status === 400)) {
      return res.status(400).json({ error: "malformed request body" });
    }
    if (err && err.type === "entity.too.large") {
      return res.status(413).json({ error: "request body too large" });
    }
    next(err);
  });

  app.use(authMiddleware);

  // health + readiness (Railway)
  app.get("/health", (_req, res) =>
    res.json({ ok: true, lane: "CW9-identity", mode: LIVE ? "supabase-live" : "day0-mock",
      auth: authIsLive() ? "verified" : "mock", money: "DARK", minor_discoverability: "DARK" })
  );
  app.get("/ready", (_req, res) => res.json({ ready: true }));

  // Mount CW9 routes via the SAME module CW16 uses on the gateway (no drift).
  // installAuth:false because we already installed authMiddleware above.
  mountCW9(app, { basePath: "/", installAuth: false });

  // 404 + catch-all error handler: always clean JSON, never a leaked stack.
  app.use((_req: Request, res: Response) => res.status(404).json({ error: "not found" }));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[CW9] unhandled:", err?.message ?? err);
    res.status(500).json({ error: "internal error" });
  });
  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 8709);
  createApp().listen(port, () => console.log(`[CW9] identity on :${port} (auth=${authIsLive() ? "verified" : "mock"}, db=${LIVE ? "live" : "mock"})`));
}
