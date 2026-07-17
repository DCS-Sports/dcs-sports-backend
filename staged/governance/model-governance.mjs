// src/model-governance.mjs
// DCS Sports · CW8 · Governance chain for Digital Twin AND ALL models. Built DARK.
//
// THE RULE THIS FILE EXISTS TO ENFORCE (dispatch):
//   threshold passed → independent review → DK approval → limited release → production
//   "NO auto-flip anywhere in code or docs."
//
// So the central design decision: **metrics can never promote a model.** Passing a threshold only
// makes a model ELIGIBLE for the next stage — a human still has to move it, and the stages are
// ordered and non-skippable. A model with 99.9% precision and no independent review is BLOCKED,
// exactly like a model with no metrics at all. That is the whole point: a metric is evidence for a
// decision, never the decision.
//
// No new crypto. No autonomy. DK is the only approver of the DK_APPROVAL stage.

export const STAGES = Object.freeze([
  'candidate',          // exists, not measured
  'threshold_passed',   // metrics meet the published gate — ELIGIBLE only, NOT promoted
  'independent_review', // reviewed by someone who did not build/train it
  'dk_approved',        // DK's explicit approval — DK only
  'limited_release',    // a bounded cohort, still reversible
  'production',         // full release
]);

const RANK = Object.fromEntries(STAGES.map((s, i) => [s, i]));

// Who may move a model INTO each stage. Nothing may be moved by 'system' — that would be an auto-flip.
const REQUIRED_ACTOR = Object.freeze({
  threshold_passed:   'system',      // the harness may RECORD eligibility (this is not a promotion)
  independent_review: 'reviewer',    // must not be the model's author
  dk_approved:        'dk',          // DK only
  limited_release:    'dk',
  production:         'dk',
});

export function makeGovernance({ clock = () => new Date().toISOString(), receiptSigner = null } = {}) {
  const models = new Map();   // model_id -> record
  const audit = [];           // append-only governance trail

  function register({ model_id, name, author_id, kind = 'model' }) {
    if (!model_id || !author_id) throw new Error('model_id + author_id required');
    if (models.has(model_id)) throw new Error('duplicate model: ' + model_id);
    const rec = {
      model_id, name: name ?? model_id, author_id, kind,
      stage: 'candidate',
      metrics: null,            // set by the CW7 shadow harness; null = unmeasured (honest)
      review: null,             // { reviewer_id, at, notes }
      dk_approval: null,        // { at, note }
      created_at: clock(),
    };
    models.set(model_id, rec);
    log(model_id, 'registered', 'system', { stage: 'candidate' });
    return rec;
  }

  // The harness reports measured metrics. This RECORDS eligibility — it does NOT promote.
  function recordMetrics(model_id, metrics, gate) {
    const m = must(model_id);
    if (!metrics || typeof metrics.precision !== 'number' || typeof metrics.recall !== 'number') {
      throw new Error('metrics must include measured precision + recall (an unmeasured model stays unmeasured)');
    }
    m.metrics = { ...metrics, measured_at: clock() };
    const passes = gate ? gate(m.metrics) : false;

    // 🔴 THE HARD RULE: passing a gate NEVER advances the stage past threshold_passed.
    if (passes && m.stage === 'candidate') {
      m.stage = 'threshold_passed';
      log(model_id, 'threshold_passed', 'system', { metrics: m.metrics, note: 'ELIGIBLE only — not promoted' });
    } else if (!passes) {
      log(model_id, 'threshold_failed', 'system', { metrics: m.metrics });
    }
    return { stage: m.stage, passes, promoted: false }; // promoted is ALWAYS false here
  }

  // Independent review — the reviewer must not be the author.
  function independentReview(model_id, { reviewer_id, notes = '' }) {
    const m = must(model_id);
    if (!reviewer_id) return deny(model_id, 'reviewer_id required');
    if (reviewer_id === m.author_id) return deny(model_id, 'review_not_independent: author cannot review own model');
    if (m.stage !== 'threshold_passed') return deny(model_id, `out_of_order: review requires threshold_passed, model is '${m.stage}'`);
    m.review = { reviewer_id, at: clock(), notes };
    m.stage = 'independent_review';
    log(model_id, 'independent_review', reviewer_id, { notes });
    return { ok: true, stage: m.stage };
  }

  // DK approval — DK only, and only after independent review.
  function dkApprove(model_id, { actor, note = '' }) {
    const m = must(model_id);
    if (actor !== 'dk') return deny(model_id, `dk_only: '${actor}' cannot approve — DK approval is DK's alone`);
    if (m.stage !== 'independent_review') return deny(model_id, `out_of_order: approval requires independent_review, model is '${m.stage}'`);
    m.dk_approval = { at: clock(), note };
    m.stage = 'dk_approved';
    log(model_id, 'dk_approved', 'dk', { note });
    return { ok: true, stage: m.stage };
  }

  // Release steps — DK only, strictly one stage at a time (no skipping to production).
  function advance(model_id, toStage, { actor }) {
    const m = must(model_id);
    if (!(toStage in RANK)) return deny(model_id, 'unknown_stage: ' + toStage);
    const required = REQUIRED_ACTOR[toStage];
    if (required === 'dk' && actor !== 'dk') return deny(model_id, `dk_only: '${actor}' cannot move a model to ${toStage}`);
    if (RANK[toStage] !== RANK[m.stage] + 1) {
      return deny(model_id, `no_skipping: cannot go '${m.stage}' → '${toStage}' (stages are ordered and non-skippable)`);
    }
    m.stage = toStage;
    log(model_id, toStage, actor, {});
    return { ok: true, stage: m.stage };
  }

  // The only question the product should ask: may this model run for real users?
  function isLive(model_id) {
    const m = models.get(model_id);
    return !!m && m.stage === 'production';
  }
  // and for a bounded cohort
  function isLimitedRelease(model_id) {
    const m = models.get(model_id);
    return !!m && (m.stage === 'limited_release' || m.stage === 'production');
  }

  function get(model_id) { return models.get(model_id) ?? null; }
  function trail(model_id) { return audit.filter(a => a.model_id === model_id); }

  function deny(model_id, reason) {
    log(model_id, 'denied', 'system', { reason });
    return { ok: false, reason, stage: models.get(model_id)?.stage };
  }
  function must(id) { const m = models.get(id); if (!m) throw new Error('unknown model: ' + id); return m; }
  function log(model_id, event, actor, detail) {
    const entry = { model_id, event, actor, detail, at: clock() };
    if (receiptSigner) entry.receipt = receiptSigner.sign ? receiptSigner.sign(entry) : receiptSigner(entry);
    audit.push(entry);
  }

  return { register, recordMetrics, independentReview, dkApprove, advance, isLive, isLimitedRelease, get, trail, STAGES };
}
