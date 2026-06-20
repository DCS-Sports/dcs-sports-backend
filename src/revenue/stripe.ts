// src/revenue/stripe.ts
// Stripe (international rail, ruling: dual-rail). DARK: PaymentIntents may be
// MODELLED in test mode, but confirm + transfer are hard-blocked until DK
// flips PAYMENTS_LIVE=1. Reuses Atlas/Agentic Stripe shape — no new rail.
import { paymentsLive, requirePaymentsLive } from './money';

export interface IntentRequest {
  amountMinor: number;     // cents
  currency: string;        // 'usd' | 'gbp' | ...
  reference: string;
  metadata?: Record<string, string>;
}

/** Test-mode PaymentIntent modelling — synthetic, no Stripe API call. */
export function modelTestIntent(req: IntentRequest) {
  return {
    id: `pi_TEST_${req.reference}`,
    amount: req.amountMinor,
    currency: req.currency.toLowerCase(),
    reference: req.reference,
    status: 'requires_confirmation',
    mode: 'test' as const,
    rail: 'stripe' as const,
    metadata: req.metadata ?? {},
  };
}

export async function confirmIntent(_intentId: string): Promise<never> {
  requirePaymentsLive('stripe.confirmIntent');
  throw new Error('[stripe] unreachable: live confirm not implemented in DARK build');
}

export async function transferSplit(_event: unknown): Promise<never> {
  requirePaymentsLive('stripe.transferSplit');
  throw new Error('[stripe] unreachable: live transfer not implemented in DARK build');
}

export const __dark = { paymentsLive };
