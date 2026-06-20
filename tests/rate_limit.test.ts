// tests/rate_limit.test.ts
import { rateLimit } from '../src/middleware/rate_limit';

function mockReqRes(ip = '1.2.3.4') {
  const req: any = { ip, socket: { remoteAddress: ip }, path: '/x' };
  let statusCode = 200;
  let payload: any = null;
  const res: any = {
    setHeader() {},
    status(c: number) { statusCode = c; return res; },
    json(p: any) { payload = p; return res; },
  };
  return { req, res, get code() { return statusCode; }, get body() { return payload; } };
}

describe('rate limiter (token bucket)', () => {
  it('allows up to capacity then 429s', () => {
    const limit = rateLimit({ capacity: 3, refillPerSec: 0 });
    let nexts = 0;
    const next = () => { nexts++; };
    const ctx = mockReqRes();
    for (let i = 0; i < 3; i++) limit(ctx.req, ctx.res as any, next);
    expect(nexts).toBe(3);
    limit(ctx.req, ctx.res as any, next); // 4th blocked
    expect(ctx.code).toBe(429);
  });

  it('isolates buckets per key', () => {
    const limit = rateLimit({ capacity: 1, refillPerSec: 0 });
    let nexts = 0;
    const next = () => { nexts++; };
    const a = mockReqRes('10.0.0.1');
    const b = mockReqRes('10.0.0.2');
    limit(a.req, a.res as any, next);
    limit(b.req, b.res as any, next);
    expect(nexts).toBe(2); // different IPs each get their own bucket
  });
});
