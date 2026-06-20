// src/revenue/money.ts
// Single source for the money-DARK guard. Canonical env: PAYMENTS_LIVE.
// DARK unless PAYMENTS_LIVE === '1' (DK-only flip). Both rails import this —
// there is exactly ONE switch, and CW16 never sets it.
export const paymentsLive = process.env.PAYMENTS_LIVE === '1';

/** Throws unless DK has flipped PAYMENTS_LIVE=1. Every real-money path on
 *  BOTH rails (Razorpay, Stripe) calls this FIRST. */
export function requirePaymentsLive(action: string): void {
  if (!paymentsLive) {
    throw new Error(
      `[money] BLOCKED: '${action}' requires PAYMENTS_LIVE=1. ` +
        'Money is DARK on both rails until DK flips. No capture, no payout.'
    );
  }
}
