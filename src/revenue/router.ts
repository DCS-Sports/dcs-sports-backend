// src/revenue/router.ts
// Dual-rail region router. India → Razorpay, everything else → Stripe.
// Both rails DARK — this only ever produces a TEST-mode order/intent.
import { modelTestOrder } from './razorpay';
import { modelTestIntent } from './stripe';

export type Rail = 'razorpay' | 'stripe';

export function pickRail(countryCode: string): Rail {
  return countryCode.toUpperCase() === 'IN' ? 'razorpay' : 'stripe';
}

export interface ChargeRequest {
  countryCode: string;     // ISO-3166 alpha-2
  amountMinor: number;     // paise for INR, cents for others
  reference: string;
  currency?: string;       // defaults INR for razorpay, usd for stripe
  metadata?: Record<string, string>;
}

/** Returns a test-mode envelope for the correct rail. No money moves. */
export function modelCharge(req: ChargeRequest) {
  const rail = pickRail(req.countryCode);
  if (rail === 'razorpay') {
    return modelTestOrder({
      amountPaise: req.amountMinor,
      receipt: req.reference,
      notes: req.metadata,
    });
  }
  return modelTestIntent({
    amountMinor: req.amountMinor,
    currency: req.currency ?? 'usd',
    reference: req.reference,
    metadata: req.metadata,
  });
}
