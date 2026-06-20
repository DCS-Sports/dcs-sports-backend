// tests/admin_selfcheck.test.ts
import { requireAdmin } from '../src/middleware/admin';

function ctx(token?: string) {
  const req: any = { headers: token ? { 'x-admin-token': token } : {} };
  let code = 200; let body: any = null;
  const res: any = { status(c: number){ code = c; return res; }, json(b: any){ body = b; return res; } };
  let nexted = false;
  const next = () => { nexted = true; };
  return { req, res, next, get code(){ return code; }, get body(){ return body; }, get nexted(){ return nexted; } };
}

describe('requireAdmin guard', () => {
  const saved = process.env.SPORTS_ADMIN_TOKEN;
  afterEach(() => { process.env.SPORTS_ADMIN_TOKEN = saved; });

  it('503s when SPORTS_ADMIN_TOKEN is unset (fail-closed, never open)', () => {
    delete process.env.SPORTS_ADMIN_TOKEN;
    const c = ctx('anything');
    requireAdmin(c.req, c.res as any, c.next);
    expect(c.code).toBe(503);
    expect(c.nexted).toBe(false);
  });

  it('403s on wrong token', () => {
    process.env.SPORTS_ADMIN_TOKEN = 'secret';
    const c = ctx('wrong');
    requireAdmin(c.req, c.res as any, c.next);
    expect(c.code).toBe(403);
    expect(c.nexted).toBe(false);
  });

  it('passes on correct token', () => {
    process.env.SPORTS_ADMIN_TOKEN = 'secret';
    const c = ctx('secret');
    requireAdmin(c.req, c.res as any, c.next);
    expect(c.nexted).toBe(true);
  });
});

describe('selfcheck fails closed without DB config', () => {
  it('selfCheckMS1 surfaces an unconfigured error rather than throwing raw', async () => {
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { selfCheckMS1 } = require('../src/harness/selfcheck');
    const r = await selfCheckMS1();
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/selfcheck error|not set|unconfigured/i);
    process.env.SUPABASE_URL = saved.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  });
});
