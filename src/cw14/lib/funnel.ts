// CW14 · v2.0 RECRUITING FUNNEL (Hudl-style) stage machine.
// Consent-gated: a minor cannot reach 'contacted' without guardian consent.
// The offer stage reuses the DARK Offer scaffold (no money, no execution).

import { randomUUID } from 'crypto';
import type { FunnelEntry, FunnelStage } from './contracts';

const NEXT: Record<FunnelStage, FunnelStage[]> = {
  shortlisted: ['contact_requested', 'closed'],
  contact_requested: ['contacted', 'closed'],
  contacted: ['trial_invited', 'offer_made', 'closed'],
  trial_invited: ['trial_completed', 'closed'],
  trial_completed: ['offer_made', 'closed'],
  offer_made: ['closed'],
  closed: [],
};

export function canAdvance(from: FunnelStage, to: FunnelStage): boolean {
  return NEXT[from]?.includes(to) ?? false;
}

export function newFunnelEntry(p: { scout_id: string; athlete_id: string; is_minor: boolean; notes?: string }): FunnelEntry {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    scout_id: p.scout_id,
    athlete_id: p.athlete_id,
    stage: 'shortlisted',
    requires_parent_consent: p.is_minor,
    parent_consent_at: null,
    trial_id: null,
    offer_id: null,
    notes: p.notes ?? null,
    created_at: now,
    updated_at: now,
    history: [{ at: now, actor: p.scout_id, action: 'shortlisted' }],
  };
}

export class FunnelError extends Error {}

export function advance(entry: FunnelEntry, to: FunnelStage, actor: string, link?: { trial_id?: string; offer_id?: string }, note?: string): FunnelEntry {
  if (!canAdvance(entry.stage, to)) {
    throw new FunnelError(`illegal funnel transition ${entry.stage} -> ${to}`);
  }
  // CONSENT GATE: a minor cannot be 'contacted' without recorded guardian consent.
  if (to === 'contacted' && entry.requires_parent_consent && !entry.parent_consent_at) {
    throw new FunnelError('parent_consent_required: minor cannot be contacted before guardian consent');
  }
  const now = new Date().toISOString();
  entry.stage = to;
  entry.updated_at = now;
  if (link?.trial_id) entry.trial_id = link.trial_id;
  if (link?.offer_id) entry.offer_id = link.offer_id;
  entry.history.push({ at: now, actor, action: `-> ${to}`, note });
  return entry;
}

export function recordFunnelConsent(entry: FunnelEntry, parent_user_id: string): FunnelEntry {
  const now = new Date().toISOString();
  entry.parent_consent_at = now;
  entry.history.push({ at: now, actor: parent_user_id, action: 'parent_consent_recorded' });
  return entry;
}
