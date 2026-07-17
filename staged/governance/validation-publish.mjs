// src/validation-publish.mjs
// DCS Sports · CW8 · Validation-publishing page template.
// Feeds from CW7's shadow-mode harness. Publishes what was MEASURED, per model.
//
// THE RULE: an unmeasured metric renders as an em-dash ("—") and says so. It never renders a
// placeholder, a target, a rounded guess, or last quarter's number from a different model. A page
// that shows 92% for a model nobody measured is worse than an empty page: it is a claim.
//
// Also: this page publishes FAILURE CONDITIONS, not just headline scores. A model that is 94%
// overall and 40% in low light has a low-light failure condition, and a buyer is entitled to it.

const DASH = '—';

// value | null → honest cell. Never invent.
function pct(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? `${(v * 100).toFixed(1)}%` : DASH;
}

export function buildValidationReport(model, { harness = null } = {}) {
  const measured = model?.metrics ?? null;
  const stage = model?.stage ?? 'unknown';

  return {
    model_id: model?.model_id ?? DASH,
    name: model?.name ?? DASH,
    // governance stage is a FACT about the model, always shown — a model can be accurate and not live
    governance_stage: stage,
    live_for_users: stage === 'production',
    measured_at: measured?.measured_at ?? null,
    metrics: {
      precision: pct(measured?.precision),
      recall: pct(measured?.recall),
      f1: pct(measured?.f1),
      sample_size: Number.isFinite(measured?.n) ? measured.n : DASH,
    },
    // failure conditions: the honest half of a validation page
    failure_conditions: Array.isArray(measured?.failure_conditions) && measured.failure_conditions.length
      ? measured.failure_conditions
      : [{ condition: DASH, note: 'not yet measured — shadow-mode harness has not reported failure conditions' }],
    // provenance so a reader can tell measurement from assertion
    provenance: {
      source: harness ?? (measured ? 'shadow_mode_harness' : null),
      status: measured ? 'measured' : 'UNMEASURED',
      note: measured
        ? 'Measured by the shadow-mode harness against official human decisions.'
        : 'No measurement exists for this model. Figures are shown as — deliberately; nothing is estimated here.',
    },
    // wording rules the page must carry (tamper-EVIDENT, estimate-labelled, human-final)
    disclaimers: [
      'Measured performance describes past matches under the stated conditions; it is not a guarantee for any future delivery.',
      'DCS Umpire Assist supports officials. The FINAL DECISION IS HUMAN.',
      'Evidence bundles are tamper-evident: they show the record was not silently rewritten. They do not prove a decision was correct.',
    ],
  };
}

// Render to HTML for the public validation page. Unmeasured → visible em-dash + an explicit line.
export function renderValidationHTML(report) {
  const rows = [
    ['Precision', report.metrics.precision],
    ['Recall', report.metrics.recall],
    ['F1', report.metrics.f1],
    ['Sample size', String(report.metrics.sample_size)],
  ].map(([k, v]) => `      <tr><th>${k}</th><td>${v}</td></tr>`).join('\n');

  const fails = report.failure_conditions
    .map(f => `      <li><b>${f.condition}</b>${f.note ? ` — ${f.note}` : ''}</li>`).join('\n');

  const unmeasuredBanner = report.provenance.status === 'UNMEASURED'
    ? `  <p class="banner unmeasured"><b>Not yet measured.</b> ${report.provenance.note}</p>\n`
    : '';

  return `<section class="validation" data-model="${report.model_id}">
  <h2>${report.name} — measured validation</h2>
  <p class="stage">Governance stage: <b>${report.governance_stage}</b> · Live for users: <b>${report.live_for_users ? 'yes' : 'no'}</b></p>
${unmeasuredBanner}  <table>
${rows}
  </table>
  <h3>Failure conditions</h3>
  <ul>
${fails}
  </ul>
  <p class="provenance">Source: ${report.provenance.source ?? DASH} · Status: ${report.provenance.status}</p>
  <ul class="disclaimers">
${report.disclaimers.map(d => `      <li>${d}</li>`).join('\n')}
  </ul>
</section>`;
}
