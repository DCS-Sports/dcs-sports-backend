// CW14 · R5/R6 OFFERS + ESCROW SCAFFOLD. NOTHING EXECUTES. MONEY DARK.
// State machine + guards only. Two hard invariants enforced in code:
//   1. A minor's offer cannot leave 'draft' until parent_consent_at is set.
//   2. mode is ALWAYS 'test'; escrow never funds/releases — only records intent.

import type { Offer, OfferStatus, EscrowRecord, EscrowState, ContractKind } from './contracts';
import { randomUUID } from 'crypto';

const ALLOWED: Record<OfferStatus, OfferStatus[]> = {
  draft: ['presented', 'withdrawn'],
  presented: ['countered', 'accepted', 'declined', 'withdrawn', 'expired'],
  countered: ['presented', 'declined', 'withdrawn', 'expired'],
  accepted: [],     // terminal in scaffold — execution is DARK
  declined: [],
  withdrawn: [],
  expired: [],
};

export function canTransition(from: OfferStatus, to: OfferStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function newOffer(p: {
  kind: ContractKind; from_user_id: string; athlete_id: string;
  terms_json: Record<string, unknown>; value_amount?: number; currency?: string;
  is_minor: boolean;
}): Offer {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    kind: p.kind,
    from_user_id: p.from_user_id,
    athlete_id: p.athlete_id,
    terms_json: p.terms_json,
    value_amount: p.value_amount ?? null,
    currency: p.currency ?? null,
    status: 'draft',
    requires_parent_consent: p.is_minor,
    parent_consent_at: null,
    mode: 'test',
    created_at: now,
    updated_at: now,
    history: [{ at: now, actor: p.from_user_id, action: 'created' }],
  };
}

export class OfferError extends Error {}

export function transition(offer: Offer, to: OfferStatus, actor: string, note?: string): Offer {
  if (!canTransition(offer.status, to)) {
    throw new OfferError(`illegal transition ${offer.status} -> ${to}`);
  }
  // INVARIANT 1: minor cannot be presented an offer without recorded parent co-consent.
  if (to === 'presented' && offer.requires_parent_consent && !offer.parent_consent_at) {
    throw new OfferError('parent_consent_required: minor offer cannot be presented before guardian co-consent');
  }
  const now = new Date().toISOString();
  offer.status = to;
  offer.updated_at = now;
  offer.history.push({ at: now, actor, action: `-> ${to}`, note });
  return offer;
}

export function recordParentConsent(offer: Offer, parent_user_id: string): Offer {
  const now = new Date().toISOString();
  offer.parent_consent_at = now;
  offer.history.push({ at: now, actor: parent_user_id, action: 'parent_consent_recorded' });
  return offer;
}

// ── ESCROW — DARK. Records intent only; no funds ever held or moved. ──
const ESCROW_NEXT: Record<EscrowState, EscrowState[]> = {
  none: ['intent_recorded'],
  intent_recorded: ['would_fund'],
  would_fund: ['would_release', 'would_refund'],
  would_release: [],
  would_refund: [],
};

export function escrowFor(offer: Offer, splits?: Record<string, number>): EscrowRecord {
  return {
    id: randomUUID(),
    offer_id: offer.id,
    state: 'none',
    amount: offer.value_amount ?? null,
    splits_json: splits ?? { athlete: 0.70, academy: 0.15, agent: 0.10, dcs: 0.05 },
    mode: 'test',
    note: 'DARK scaffold — no funds held or moved. State tracks intent only.',
  };
}

export function escrowTransition(rec: EscrowRecord, to: EscrowState): EscrowRecord {
  if (!ESCROW_NEXT[rec.state]?.includes(to)) {
    throw new OfferError(`illegal escrow transition ${rec.state} -> ${to}`);
  }
  rec.state = to;
  rec.note = `DARK scaffold — '${to}' recorded as INTENT. No money moved (mode=test).`;
  return rec;
}
