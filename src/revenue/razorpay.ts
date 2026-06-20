// src/revenue/razorpay.ts
// Razorpay (India rail). DARK: orders may be MODELLED in test mode, but
// capture + payout are hard-blocked until DK flips PAYMENTS_LIVE=1.
// Reuses DCS Rank's live+GST-tested integration shape — no new payment build.
import { paymentsLive, requirePaymentsLive } from './money';

export interface OrderRequest {
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}

/** Test-mode order modelling — synthetic envelope, no Razorpay API call. */
export function modelTestOrder(req: OrderRequest) {
  return {
    id: `order_TEST_${req.receipt}`,
    amount: req.amountPaise,
    currency: 'INR',
    receipt: req.receipt,
    status: 'created',
    mode: 'test' as const,
    rail: 'razorpay' as const,
    notes: req.notes ?? {},
  };
}

export async function capturePayment(_paymentId: string, _amountPaise: number): Promise<never> {
  requirePaymentsLive('razorpay.capturePayment');
  throw new Error('[razorpay] unreachable: live capture not implemented in DARK build');
}

export async function payoutSplit(_event: unknown): Promise<never> {
  requirePaymentsLive('razorpay.payoutSplit');
  throw new Error('[razorpay] unreachable: live payout not implemented in DARK build');
}

export const __dark = { paymentsLive };
