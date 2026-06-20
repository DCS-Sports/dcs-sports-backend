import express, { type Express } from "express";
import { buildRouter, type DBFactory } from "./routes/cw15";
import { InMemoryDB, type DBPort } from "./db/port";
import { InMemoryQueue, type Queue } from "./lib/queue";
import { SupabaseDB, supabaseConfigFromEnv } from "./db/supabase";
import { bullmqFromEnv } from "./lib/bullmq";

/**
 * Standalone dev/test server. In production these routes are mounted into
 * CW16's live gateway via `mountCw15` (src/gateway.ts) — not run separately.
 *
 * DB factory: Supabase when env present (live `llhyntwsgtimfpedukro`), else the
 * in-memory mock so `npm ci && npm test` is green without a live DB.
 */
function defaultFactory(): { factory: DBFactory; backend: "supabase" | "memory" } {
  const cfg = supabaseConfigFromEnv();
  if (cfg) {
    return {
      backend: "supabase",
      factory: (token) => new SupabaseDB({ ...cfg, callerToken: token ?? null }),
    };
  }
  const mock = new InMemoryDB();
  return { backend: "memory", factory: () => mock };
}

export function createApp(deps?: { db?: DBPort; dbFactory?: DBFactory; queue?: Queue }): Express {
  const queue = deps?.queue ?? bullmqFromEnv() ?? new InMemoryQueue();
  let factory: DBFactory;
  let backend: "supabase" | "memory" | "injected" = "injected";
  if (deps?.dbFactory) {
    factory = deps.dbFactory;
  } else if (deps?.db) {
    const db = deps.db;
    factory = () => db;
  } else {
    const d = defaultFactory();
    factory = d.factory;
    backend = d.backend;
  }

  const app = express();
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_req, res) =>
    res.json({ ok: true, lane: "CW15", backend, scope: "vision+coach_ai+talent+performance_lab" }),
  );
  app.use("/", buildRouter(factory, queue));
  return app;
}

const isMain = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMain) {
  const port = Number(process.env.PORT ?? 8015);
  createApp().listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`CW15 standalone listening on :${port}`);
  });
}
