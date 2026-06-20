// CW13 — standalone server (for lane dev). At integration, CW16's gateway
// mounts `router` instead of running this directly.
import express from 'express';
import { router } from './routes/verify';

export const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ lane: 'CW13', ok: true }));
app.use(router);

const PORT = Number(process.env.PORT) || 5013;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`CW13 verification authority on :${PORT}`));
}
