// DCS Intelligence — ingest service (wraps CW24 Agentic V2 modules).
// Receives cross-product receipts/beacons, verifies trustlessly, stores by dcs_user_id.
// Also serves the integrations marketplace catalog. Money + automation DARK.
import http from "node:http";
import { ingestHandler, ingested } from "./src/CW24_AgenticV2_intelligence-ingest.mjs";
import { catalog } from "./src/CW24_AgenticV2_marketplace-explorer.mjs";

const PORT = process.env.PORT || 8082;
const MONEY_DARK = process.env.AUTOMATION_LIVE !== "1";  // automation/settlement DARK by default
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization,x-dashboard-token,x-device-id" };
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", ...cors }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz"))
    return send(res, 200, {
      ok: true, service: "dcs-intelligence-ingest", money_dark: MONEY_DARK, autonomy: "DARK",
      connectors: {
        supabase:   !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
        github:     !!process.env.GITHUB_TOKEN,
        railway:    !!process.env.RAILWAY_API_TOKEN,
        cloudflare: !!process.env.CLOUDFLARE_API_TOKEN,
        youtube:    !!process.env.YOUTUBE_API_KEY,
        discord:    !!process.env.DISCORD_BOT_TOKEN_TRD,
        telegram:   !!(process.env.TELEGRAM_BOT_TOKEN_TRD && process.env.TELEGRAM_CHANNEL_CHAT_ID_TRD && process.env.TELEGRAM_GROUP_CHAT_ID_TRD),
        devto:      !!process.env.DEVTO_API_KEY,
        hashnode:   !!process.env.HASHNODE_TOKEN,
        linkedin:   !!process.env.LINKEDIN_ACCESS_TOKEN,
        x:          !!process.env.X_BEARER_TOKEN,
        medium:     !!process.env.MEDIUM_TOKEN,
        anthropic:  !!process.env.ANTHROPIC_API_KEY,
        openai:     !!process.env.OPENAI_API_KEY,
        posthog:    !!process.env.POSTHOG_API_KEY,
        ga4:        !!process.env.GA4_PROPERTY_ID,
        stripe:     !!process.env.STRIPE_SECRET_KEY,
        razorpay:   !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      }
    });
  if (req.method === "GET" && url.pathname === "/api/integrations/marketplace")
    return send(res, 200, { catalog: catalog() });
  if (req.method === "GET" && url.pathname === "/api/intelligence/feed")
    return send(res, 200, { pending: ingested(), note: "DARK in-memory sink; DK wires the real Intelligence store (Supabase/warehouse)" });
  if (req.method === "POST" && url.pathname === "/api/intelligence/ingest") {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", () => { let body = {}; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch {} const r = ingestHandler({ body }); send(res, r.status, r.json); });
    return;
  }
  send(res, 404, { ok: false, error: "not_found" });
});
server.listen(PORT, () => console.log(JSON.stringify({ msg: "dcs-intelligence-ingest up", port: PORT, money_dark: MONEY_DARK })));
