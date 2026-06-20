// tests/monitoring.test.ts
import { deepHealth } from '../src/gateway/monitoring';

describe('deep health monitoring', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('degrades to unconfigured (not down) with no infra env', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SPORTS_REDIS_URL;
    const h = await deepHealth();
    expect(h.dependencies.supabase.status).toBe('unconfigured');
    expect(h.dependencies.redis.status).toBe('unconfigured');
    // unconfigured is not 'down' => not flagged unhealthy on a fresh box
    expect(h.healthy).toBe(true);
  });

  it('reports DARK money posture by default', async () => {
    delete process.env.PAYMENTS_LIVE;
    const h = await deepHealth();
    expect(h.posture.money).toBe('DARK');
    expect(h.posture.payments_live).toBe(false);
  });

  it('reflects PAYMENTS_LIVE=1 as LIVE', async () => {
    process.env.PAYMENTS_LIVE = '1';
    const h = await deepHealth();
    expect(h.posture.money).toBe('LIVE');
  });

  it('toggles ed25519 readiness with keys present', async () => {
    delete process.env.SPORTS_ED25519_PRIVATE_KEY;
    delete process.env.SPORTS_ED25519_PUBLIC_KEY;
    let h = await deepHealth();
    expect(h.posture.ed25519_signing).toBe('unconfigured');
    process.env.SPORTS_ED25519_PRIVATE_KEY = 'x';
    process.env.SPORTS_ED25519_PUBLIC_KEY = 'y';
    h = await deepHealth();
    expect(h.posture.ed25519_signing).toBe('ready');
  });

  it('includes the M-S1..M-S4 gate rollup', async () => {
    const h = await deepHealth();
    expect(h.gates.map((g) => g.gate)).toEqual(['M-S1', 'M-S2', 'M-S3', 'M-S4']);
  });
});
