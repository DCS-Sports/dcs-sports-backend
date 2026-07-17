/**
 * evidence-passport/render.mjs — human-readable export (HTML; print-to-PDF clean).
 * Every surface carries the tamper-EVIDENT wording pair. Estimates are labelled.
 */
import { WORDING } from './passport.mjs';

const esc = (s) => String(s ?? '—').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderPassportHtml(bundle, verification) {
  const m = bundle.match;
  const rows = bundle.incidents.map((r) => {
    const inc = JSON.parse(r.body.attestation);
    const conf = inc.confidence == null ? '—' : `${Math.round(inc.confidence * 100)}% <em>(estimate)</em>`;
    const corrections = (inc.corrections ?? []).map(c => `${esc(c.field)}: ${esc(c.from)} → ${esc(c.to)} (${esc(c.by)})`).join('<br>') || 'none';
    return `<section class="card ${inc.decision}">
      <h3>${esc(inc.overBall)} · ${esc(inc.evidenceLabel)} · <span class="badge">${inc.decision.toUpperCase()}</span></h3>
      <table>
        <tr><th>On-field call</th><td>${esc(inc.onFieldCall)}</td><th>Review reason</th><td>${esc(inc.reviewReason)}</td></tr>
        <tr><th>Model confidence</th><td>${conf}</td><th>Final decision by</th><td><strong>${esc(inc.reviewer)}</strong> (human)</td></tr>
        <tr><th>Cameras</th><td>${esc((inc.sourceCameraIds ?? []).join(', '))}</td><th>Calibration / model</th><td>${esc(inc.calibrationVersion)} / ${esc(inc.modelVersion)}</td></tr>
        <tr><th>Media hashes</th><td colspan="3"><code>${(inc.mediaHashes ?? []).map(h => esc(h.cameraId + ':' + h.sha256.slice(0, 16) + '…')).join(' · ') || '—'}</code>${inc.audioHash ? ` · audio <code>${esc(inc.audioHash.slice(0, 16))}…</code>` : ''}</td></tr>
        <tr><th>Corrections</th><td colspan="3">${corrections}</td></tr>
        <tr><th>Receipt</th><td colspan="3"><code>${r.receipt_hash}</code> · prev <code>${r.prev_hash ? r.prev_hash.slice(0, 16) + '…' : 'genesis'}</code> · ${esc(r.ts)}</td></tr>
      </table>
    </section>`;
  }).join('\n');

  const v = verification?.ok
    ? `<p class="ok">✓ Verified: ${verification.incidents} incident records, unbroken lineage, registered key${verification.productionKey ? '' : ' — <strong>DEMO KEY (ephemeral): not a production attestation</strong>'}.</p>`
    : `<p class="bad">✗ VERIFICATION FAILED: ${esc(verification?.reason)}</p>`;

  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Match Evidence Passport · ${esc(m.matchId)}</title>
<style>body{font:15px/1.5 system-ui;margin:2rem auto;max-width:60rem;color:#16323f}
.card{border:1px solid #d7e2e8;border-radius:10px;padding:1rem;margin:1rem 0}.card.rejected{border-color:#c98}
.badge{font-size:.8em;padding:.1em .5em;border-radius:6px;background:#e8f2ee}.rejected .badge{background:#f6e3dc}
table{width:100%;border-collapse:collapse}th{text-align:left;color:#5a7482;font-weight:600;padding:.2em .6em .2em 0;width:12em}td{padding:.2em .6em .2em 0}
.claim{background:#eef6f3;border-left:4px solid #2e7d64;padding:.8rem 1rem}.nonclaim{background:#fdf3ec;border-left:4px solid #c96f3b;padding:.8rem 1rem}
.ok{color:#2e7d64}.bad{color:#b3402a}code{font-size:.85em}</style>
<h1>DCS Sports · Match Evidence Passport</h1>
<p><strong>${esc(m.title ?? m.matchId)}</strong> · ${esc(m.venue)} · ${esc(m.date)}</p>
<div class="claim">${esc(WORDING.claim)}</div>
<div class="nonclaim"><strong>${esc(WORDING.nonClaim)}</strong> ${esc(WORDING.estimate)}</div>
${v}
<h2>Reviewed incidents (${bundle.incidents.length})</h2>
${rows}
<h2>Bundle attestation</h2>
<p>Key id <code>${esc(bundle.keyId)}</code> · terminal receipt <code>${bundle.terminal.receipt_hash}</code> · generated ${esc(JSON.parse(bundle.terminal.body.attestation).generatedAt)}</p>
<p>Verify independently: fetch the JSON form of this passport, resolve the key id against the published DCS Sports key registry, and run <code>verifyPassport(bundle, registry)</code>.</p>
</html>`;
}
