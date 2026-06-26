/**
 * CW22 — Explorer Supabase Hydration Adapters
 * Wires CW17 (Civilization Memory Vault), CW22 (Org Memory Graph v2),
 * CW23 (Enterprise Audit Copilot) → atlas_explorer_feed
 *
 * Security: AV2_ATLAS_BIND gate + fail-open. No money/autonomy.
 * All *_LIVE=0 until Phase 4.
 */

import { SupabaseClient } from '@supabase/supabase-js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AtlasProduct =
  | 'agentic'
  | 'civ_memory'    // CW17 Civilization Memory Vault
  | 'org_memory'    // CW22 Org Memory Graph v2
  | 'audit_copilot' // CW23 Enterprise Audit Copilot
  | 'atlas';

export interface AtlasFeedRow {
  product: AtlasProduct;
  dcs_user_id: string;
  subject_type: string;
  subject_id: string;
  receipt_hash: string;
  verified: boolean;
  ts: string; // ISO 8601
  metadata?: Record<string, unknown>;
}

export type AtlasSink = (row: AtlasFeedRow) => Promise<{ ok: boolean }>;

// ── Shared sink ───────────────────────────────────────────────────────────────

/**
 * tableSink — writes to atlas_explorer_feed; dedupes on receipt_hash.
 * 23505 = unique_violation = row already present = treat as success.
 */
export function tableSink(db: SupabaseClient): AtlasSink {
  return async (row) => {
    const { error } = await db.from('atlas_explorer_feed').insert(row);
    if (error && error.code !== '23505') {
      console.error('[ExplorerHydration] sink error', error.message);
      return { ok: false };
    }
    return { ok: true };
  };
}

/**
 * resolveDcsUserId — look up dcs_identity_map; fall back to raw authUserId.
 */
export async function resolveDcsUserId(
  db: SupabaseClient,
  authUserId: string,
): Promise<string> {
  const { data } = await db
    .from('dcs_identity_map')
    .select('dcs_user_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  return data?.dcs_user_id ?? authUserId;
}

// ── CW17 — Civilization Memory Vault adapter ──────────────────────────────────

export interface CivMemoryRecord {
  id: string;
  user_id: string;
  memory_type: string; // 'episodic' | 'semantic' | 'procedural'
  content_hash: string;
  source_id?: string;
  ts: string;
}

/**
 * hydrateCivMemory
 * Called when a memory record is written to the Civilization Memory Vault.
 * Surfaces it into the Atlas Explorer feed so the trust graph can reference it.
 */
export async function hydrateCivMemory(
  db: SupabaseClient,
  record: CivMemoryRecord,
  sink?: AtlasSink,
): Promise<{ ok: boolean }> {
  if (!process.env.AV2_ATLAS_BIND || process.env.AV2_ATLAS_BIND !== '1') {
    return { ok: true }; // gate closed — succeed silently
  }

  const write = sink ?? tableSink(db);
  const dcs_user_id = await resolveDcsUserId(db, record.user_id);

  const row: AtlasFeedRow = {
    product: 'civ_memory',
    dcs_user_id,
    subject_type: `memory:${record.memory_type}`,
    subject_id: record.id,
    receipt_hash: record.content_hash,
    verified: true, // content_hash is computed by CW17 at write time
    ts: record.ts,
    metadata: { source_id: record.source_id },
  };

  try {
    return await write(row);
  } catch (e) {
    console.error('[CivMemory] hydration fail-open', e);
    return { ok: true }; // fail-open: never block memory writes
  }
}

/**
 * backfillCivMemory
 * Pushes all existing Civilization Memory records for a user into Explorer.
 * Call once after AV2_ATLAS_BIND=1 is flipped to populate historical data.
 */
export async function backfillCivMemory(
  db: SupabaseClient,
  authUserId: string,
  sink?: AtlasSink,
): Promise<{ hydrated: number; errors: number }> {
  const dcs_user_id = await resolveDcsUserId(db, authUserId);
  const { data: records, error } = await db
    .from('civ_memory_records')
    .select('*')
    .eq('user_id', authUserId)
    .order('ts', { ascending: true });

  if (error || !records) return { hydrated: 0, errors: 1 };

  const write = sink ?? tableSink(db);
  let hydrated = 0, errors = 0;

  for (const rec of records) {
    try {
      const r = await write({
        product: 'civ_memory',
        dcs_user_id,
        subject_type: `memory:${rec.memory_type}`,
        subject_id: rec.id,
        receipt_hash: rec.content_hash,
        verified: true,
        ts: rec.ts,
      });
      if (r.ok) hydrated++; else errors++;
    } catch { errors++; }
  }

  return { hydrated, errors };
}

// ── CW22 — Org Memory Graph v2 adapter ───────────────────────────────────────

export interface OrgMemoryEdge {
  id: string;
  org_id: string;
  user_id: string;
  from_node: string;  // entity ID
  to_node: string;    // entity ID
  relation: string;   // 'reports_to' | 'collaborates_with' | 'owns' | etc.
  edge_hash: string;
  ts: string;
}

/**
 * hydrateOrgMemoryEdge
 * Called when a new edge is added to the Org Memory Graph.
 * Surfaces relationship data into the Atlas trust graph feed.
 */
export async function hydrateOrgMemoryEdge(
  db: SupabaseClient,
  edge: OrgMemoryEdge,
  sink?: AtlasSink,
): Promise<{ ok: boolean }> {
  if (process.env.AV2_ATLAS_BIND !== '1') return { ok: true };

  const write = sink ?? tableSink(db);
  const dcs_user_id = await resolveDcsUserId(db, edge.user_id);

  const row: AtlasFeedRow = {
    product: 'org_memory',
    dcs_user_id,
    subject_type: `org_edge:${edge.relation}`,
    subject_id: edge.id,
    receipt_hash: edge.edge_hash,
    verified: true,
    ts: edge.ts,
    metadata: {
      org_id: edge.org_id,
      from_node: edge.from_node,
      to_node: edge.to_node,
      relation: edge.relation,
    },
  };

  try {
    return await write(row);
  } catch (e) {
    console.error('[OrgMemory] hydration fail-open', e);
    return { ok: true };
  }
}

/**
 * backfillOrgMemoryGraph
 * Pushes all Org Memory Graph edges for an org into the Atlas Explorer feed.
 */
export async function backfillOrgMemoryGraph(
  db: SupabaseClient,
  orgId: string,
  requestingUserId: string,
  sink?: AtlasSink,
): Promise<{ hydrated: number; errors: number }> {
  const dcs_user_id = await resolveDcsUserId(db, requestingUserId);
  const { data: edges, error } = await db
    .from('org_memory_edges')
    .select('*')
    .eq('org_id', orgId)
    .order('ts', { ascending: true });

  if (error || !edges) return { hydrated: 0, errors: 1 };

  const write = sink ?? tableSink(db);
  let hydrated = 0, errors = 0;

  for (const edge of edges) {
    try {
      const r = await write({
        product: 'org_memory',
        dcs_user_id,
        subject_type: `org_edge:${edge.relation}`,
        subject_id: edge.id,
        receipt_hash: edge.edge_hash,
        verified: true,
        ts: edge.ts,
        metadata: { org_id: edge.org_id, from_node: edge.from_node, to_node: edge.to_node },
      });
      if (r.ok) hydrated++; else errors++;
    } catch { errors++; }
  }

  return { hydrated, errors };
}

// ── CW23 — Enterprise Audit Copilot adapter ───────────────────────────────────

export interface AuditFinding {
  id: string;
  org_id: string;
  user_id: string;
  finding_type: string; // 'compliance' | 'anomaly' | 'risk' | 'access_review'
  severity: 'low' | 'medium' | 'high' | 'critical';
  finding_hash: string;
  summary: string;
  ts: string;
}

/**
 * hydrateAuditFinding
 * Called when the Audit Copilot emits a new finding.
 * Surfaces the finding hash + severity into the Atlas trust graph.
 */
export async function hydrateAuditFinding(
  db: SupabaseClient,
  finding: AuditFinding,
  sink?: AtlasSink,
): Promise<{ ok: boolean }> {
  if (process.env.AV2_ATLAS_BIND !== '1') return { ok: true };

  const write = sink ?? tableSink(db);
  const dcs_user_id = await resolveDcsUserId(db, finding.user_id);

  const row: AtlasFeedRow = {
    product: 'audit_copilot',
    dcs_user_id,
    subject_type: `audit:${finding.finding_type}:${finding.severity}`,
    subject_id: finding.id,
    receipt_hash: finding.finding_hash,
    verified: true,
    ts: finding.ts,
    metadata: {
      org_id: finding.org_id,
      severity: finding.severity,
      summary: finding.summary.slice(0, 256), // truncate for feed
    },
  };

  try {
    return await write(row);
  } catch (e) {
    console.error('[AuditCopilot] hydration fail-open', e);
    return { ok: true };
  }
}

// ── HTTP route handlers (mount in atlas-api Express/Hono app) ─────────────────

/**
 * registerExplorerHydrationRoutes
 *
 * POST /internal/hydrate/civ-memory   → hydrateCivMemory
 * POST /internal/hydrate/org-memory   → hydrateOrgMemoryEdge
 * POST /internal/hydrate/audit        → hydrateAuditFinding
 * POST /internal/backfill/civ-memory  → backfillCivMemory (user)
 * POST /internal/backfill/org-memory  → backfillOrgMemoryGraph (org)
 *
 * All routes require internal service token (X-Internal-Token header).
 * Never exposed to public internet — behind Railway internal networking.
 */
export function registerExplorerHydrationRoutes(app: any, db: SupabaseClient) {
  const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;

  function authInternal(req: any, res: any, next: any) {
    if (!INTERNAL_TOKEN || req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  }

  app.post('/internal/hydrate/civ-memory', authInternal, async (req: any, res: any) => {
    const r = await hydrateCivMemory(db, req.body);
    res.json(r);
  });

  app.post('/internal/hydrate/org-memory', authInternal, async (req: any, res: any) => {
    const r = await hydrateOrgMemoryEdge(db, req.body);
    res.json(r);
  });

  app.post('/internal/hydrate/audit', authInternal, async (req: any, res: any) => {
    const r = await hydrateAuditFinding(db, req.body);
    res.json(r);
  });

  app.post('/internal/backfill/civ-memory', authInternal, async (req: any, res: any) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const r = await backfillCivMemory(db, userId);
    res.json(r);
  });

  app.post('/internal/backfill/org-memory', authInternal, async (req: any, res: any) => {
    const { orgId, requestingUserId } = req.body;
    if (!orgId || !requestingUserId) return res.status(400).json({ error: 'orgId + requestingUserId required' });
    const r = await backfillOrgMemoryGraph(db, orgId, requestingUserId);
    res.json(r);
  });
}
