// CW12 — League OS service entry.
// Mounts on the shared dcs-sports-backend (Railway). CW16 owns the gateway;
// this router is designed to mount cleanly under it. Standalone here for the lane.

import express from 'express';
import { leagueRouter } from './routes/league';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true, lane: 'CW12-league-os' }));
  app.use('/', leagueRouter);
  // error handler — async repo failures surface as clean JSON, not stack traces
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('[CW12 error]', err.message);
    res.status(500).json({ error: 'internal', detail: err.message });
  });
  return app;
}

const PORT = Number(process.env.PORT ?? 8012);

// start only when run directly
if (process.env.NODE_ENV !== 'test') {
  const app = createApp();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[CW12 League OS] listening on :${PORT}`);
  });
}
