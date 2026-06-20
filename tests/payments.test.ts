// tests/payments.test.ts
import { pickRail, modelCharge } from '../src/revenue/router';
import { capturePayment, payoutSplit } from '../src/revenue/razorpay';
import { confirmIntent, transferSplit } from '../src/revenue/stripe';

describe('dual-rail routing', () => {
  it('routes India to Razorpay, everything else to Stripe', () => {
    expect(pickRail('IN')).toBe('razorpay');
    expect(pickRail('US')).toBe('stripe');
    expect(pickRail('gb')).toBe('stripe');
  });

  it('models a test-mode Razorpay order for IN', () => {
    const c: any = modelCharge({ countryCode: 'IN', amountMinor: 49900, reference: 'R1' });
    expect(c.rail).toBe('razorpay');
    expect(c.mode).toBe('test');
    expect(c.currency).toBe('INR');
  });

  it('models a test-mode Stripe intent for non-IN', () => {
    const c: any = modelCharge({ countryCode: 'US', amountMinor: 999, reference: 'R2', currency: 'usd' });
    expect(c.rail).toBe('stripe');
    expect(c.mode).toBe('test');
  });
});

describe('money DARK — both rails block live ops (PAYMENTS_LIVE unset)', () => {
  it('Razorpay capture/payout throw', async () => {
    await expect(capturePayment('p', 100)).rejects.toThrow(/PAYMENTS_LIVE/);
    await expect(payoutSplit({})).rejects.toThrow(/PAYMENTS_LIVE/);
  });
  it('Stripe confirm/transfer throw', async () => {
    await expect(confirmIntent('pi')).rejects.toThrow(/PAYMENTS_LIVE/);
    await expect(transferSplit({})).rejects.toThrow(/PAYMENTS_LIVE/);
  });
});
