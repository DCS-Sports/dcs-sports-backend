// src/routes/identity.ts  (CW9 surface — integration impl by CW16)
// /me, grants CRUD, parent-link consent. Real DB-backed; RLS enforced for
// reads. CW9 owns deep auth; this is the gateway-mounted route contract.
import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { svc, rls, ok, fail, h } from './_helpers';

export const identityRouter = Router();

// GET /me — the caller's user row (RLS: a user reads their own row)
identityRouter.get('/me', requireAuth, h(async (req: AuthedRequest, res) => {
  const db = rls(req)!;
  const { data, error } = await db.from('sports_users').select('id,name,email,role_flags,dob').single();
  if (error) return fail(res, 403, error.message);
  return ok(res, data);
}));

// POST /grants — athlete (or parent of minor) grants a scope to a grantee
identityRouter.post('/grants', requireAuth, h(async (req: AuthedRequest, res) => {
  const { athlete_id, grantee_id, scope } = req.body ?? {};
  if (!athlete_id || !grantee_id || !scope) return fail(res, 400, 'athlete_id, grantee_id, scope required');
  const { data, error } = await svc()
    .from('sports_data_access_grants')
    .insert({ athlete_id, grantee_id, scope, granted_at: new Date().toISOString() })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));

// DELETE /grants/:id — revoke (sets revoked_at)
identityRouter.delete('/grants/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const { error } = await svc()
    .from('sports_data_access_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return fail(res, 400, error.message);
  return ok(res, { revoked: true });
}));

// POST /parent-links — link a parent to an athlete with consent flag
identityRouter.post('/parent-links', requireAuth, h(async (req: AuthedRequest, res) => {
  const { parent_user_id, athlete_id, relation, consent } = req.body ?? {};
  const { data, error } = await svc()
    .from('sports_parent_links')
    .insert({
      parent_user_id, athlete_id, relation,
      consent: Boolean(consent),
      consented_at: consent ? new Date().toISOString() : null,
    })
    .select()
    .single();
  if (error) return fail(res, 400, error.message);
  return ok(res, data);
}));
