/**
 * evidence-passport/handler.mjs — the endpoint, as a PURE FUNCTION.
 *
 * GET /matches/:id/evidence-passport            → signed JSON bundle
 * GET /matches/:id/evidence-passport?format=html → human-readable export
 *
 * INTEGRATION (blocked on the gateway repo — see HANDOFF): one route line, e.g.
 *   app.get('/matches/:id/evidence-passport', (req,res) => evidencePassportHandler(source, registry, req.params.id, req.query.format).then(r => res.status(r.status).type(r.type).send(r.body)))
 *
 * `source` is the port this module declares INSTEAD of guessing the repo's schema:
 *   source.getMatch(matchId)      → match summary object (or null)
 *   source.getIncidents(matchId)  → reviewed-incident records (CW3's fusion decisions land here)
 */
import { buildPassportBundle, verifyPassport } from './passport.mjs';
import { renderPassportHtml } from './render.mjs';

export async function evidencePassportHandler(source, registry, matchId, format) {
  const match = await source.getMatch(matchId);
  if (!match) return { status: 404, type: 'application/json', body: JSON.stringify({ error: `no match ${matchId}` }) };
  const incidents = await source.getIncidents(matchId);
  const bundle = buildPassportBundle({ match, incidents });
  if (format === 'html') {
    const v = verifyPassport(bundle, registry);   // the export self-checks before it renders
    return { status: 200, type: 'text/html', body: renderPassportHtml(bundle, v) };
  }
  return { status: 200, type: 'application/json', body: JSON.stringify(bundle) };
}
