// src/revenue/reconcile.ts
// Full split -> payout reconciliation cycle (v3.0), TEST MODE ONLY. Computes
// splits for a batch of revenue events, groups payouts per beneficiary, and
// proves the books balance: sum(payouts) === sum(gross), no leakage, no money
// moved. This is the dress rehearsal for the money-flip — DARK throughout.
import { computeSplit, SplitConfig, DEFAULT_SPLIT } from './splits';
import { RevenueSource } from '../types';

export interface RevenueInput {
  id: string;
  source: RevenueSource;
  athlete_id: string;
  academy_id?: string | null;
  agent_id?: string | null;
  gross_paise: number;
}

export type Beneficiary = 'athlete' | 'academy' | 'agent' | 'dcs';

export interface PayoutLine {
  beneficiary: Beneficiary;
  ref: string;          // beneficiary id (or 'DCS')
  amount_paise: number;
}

export interface ReconcileResult {
  mode: 'test';
  events: number;
  gross_total: number;
  payout_total: number;
  balanced: boolean;          // payout_total === gross_total
  per_beneficiary: Record<Beneficiary, number>;
  payouts: PayoutLine[];
  leakage_paise: number;      // gross_total - payout_total (must be 0)
}

/** Run the cycle over a batch. Each event splits 70/15/10/5 (configurable),
 *  produces four payout lines, and we assert the grand total reconciles. */
export function reconcile(events: RevenueInput[], cfg: SplitConfig = DEFAULT_SPLIT): ReconcileResult {
  const payouts: PayoutLine[] = [];
  const perBeneficiary: Record<Beneficiary, number> = { athlete: 0, academy: 0, agent: 0, dcs: 0 };
  let grossTotal = 0;

  for (const e of events) {
    const split = computeSplit(e.gross_paise, cfg);
    grossTotal += e.gross_paise;

    const lines: PayoutLine[] = [
      { beneficiary: 'athlete', ref: e.athlete_id, amount_paise: split.athlete },
      { beneficiary: 'academy', ref: e.academy_id ?? 'UNASSIGNED_ACADEMY', amount_paise: split.academy },
      { beneficiary: 'agent', ref: e.agent_id ?? 'UNASSIGNED_AGENT', amount_paise: split.agent },
      { beneficiary: 'dcs', ref: 'DCS', amount_paise: split.dcs },
    ];
    for (const l of lines) {
      payouts.push(l);
      perBeneficiary[l.beneficiary] += l.amount_paise;
    }
  }

  const payoutTotal = payouts.reduce((s, l) => s + l.amount_paise, 0);
  const leakage = grossTotal - payoutTotal;

  return {
    mode: 'test',
    events: events.length,
    gross_total: grossTotal,
    payout_total: payoutTotal,
    balanced: leakage === 0,
    per_beneficiary: perBeneficiary,
    payouts,
    leakage_paise: leakage,
  };
}

/** Net per beneficiary ref (what a real payout batch would disburse). Still test. */
export function netByRef(result: ReconcileResult): Record<string, number> {
  const byRef: Record<string, number> = {};
  for (const l of result.payouts) {
    byRef[l.ref] = (byRef[l.ref] ?? 0) + l.amount_paise;
  }
  return byRef;
}
