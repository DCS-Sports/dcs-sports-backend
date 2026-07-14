/**
 * 🔴 THE TEST THAT WOULD HAVE CAUGHT THE OUTAGE.   15 Jul 2026
 *
 * The app failed with "Could not load passport" because the gateway had NO CORS — the browser
 * blocked every cross-origin call. The existing suite never noticed, because (per the CW25 audit)
 * NO test in this repo ever makes an HTTP request to the mounted app. tests/integration.test.ts
 * only inspects app._router.stack. A suite that never hits the gateway stays green while the app is
 * unreachable.
 *
 * This test boots the REAL createApp() and speaks HTTP to it — the first test here that does.
 * Run after `npm install`:  npx jest tests/cors.test.ts
 */
import { createApp } from '../src/gateway/server';
import type { Server } from 'http';

const ALLOWED = 'https://app.sports.dcsai.ai';
const DENIED  = 'https://evil.example.com';

let server: Server; let base: string;

beforeAll(async () => {
  process.env.ALLOWED_ORIGINS = `${ALLOWED},https://sports.dcsai.ai`;
  await new Promise<void>((r) => { server = createApp().listen(0, () => {
    const a = server.address(); base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`; r();
  }); });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

test('an ALLOWED origin gets its Access-Control-Allow-Origin echoed', async () => {
  const res = await fetch(`${base}/health`, { headers: { Origin: ALLOWED } });
  expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
});

test('the passport Authorization header is permitted', async () => {
  const res = await fetch(`${base}/health`, { headers: { Origin: ALLOWED } });
  expect((res.headers.get('access-control-allow-headers') || '')).toMatch(/authorization/i);
});

test('🔴 a DENIED origin gets NO CORS header (the browser will block it)', async () => {
  const res = await fetch(`${base}/health`, { headers: { Origin: DENIED } });
  expect(res.headers.get('access-control-allow-origin')).toBeNull();
});

test('OPTIONS preflight: allowed → 204, denied → 403', async () => {
  const ok = await fetch(`${base}/athletes/x`, { method: 'OPTIONS', headers: { Origin: ALLOWED } });
  expect(ok.status).toBe(204);
  const no = await fetch(`${base}/athletes/x`, { method: 'OPTIONS', headers: { Origin: DENIED } });
  expect(no.status).toBe(403);
});

test('a request with NO Origin (curl / same-origin) still works', async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(200);
});
