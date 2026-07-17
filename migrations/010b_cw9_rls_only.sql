-- RLS-ONLY extract of the CW9 identity bundle (idempotent).
-- Table creation stripped (your live DB already has the tables); this applies
-- ONLY the security: helper functions, RLS enablement, and policies.
-- TEST ON A SUPABASE BRANCH FIRST. Then merge to production.

create extension if not exists "pgcrypto";

all lanes read)
-- Fresh Supabase project `dcs-sports` · public schema · sports_ prefix
-- Frozen 19 Jun 2026 per DAY-0 MANAGER REPLY. Do NOT fork shapes — extend via new migrations.
-- Honest-scope: RLS-first · money DARK · AI=estimate · verification human-in-loop.
-- =====================================================================

create extension if not exists "pgcrypto";
create index on sports_athletes (user_id);
create index on sports_athletes (sport, state, role);
create index on sports_athletes (visibility);
create index on sports_athlete_stats (athlete_id, season);
create index on sports_match_performances (athlete_id);
create index on sports_match_performances (match_id);
create index on sports_attendance (athlete_id, date);
create index on sports_matches (league_id, status);
create index on sports_live_scores (match_id, ts);
create index on sports_verifications (entity_type, entity_id);
alter table sports_parent_links
  add constraint fk_plinks_athlete foreign key (athlete_id) references sports_athletes(id) on delete cascade;
alter table sports_athletes
  add constraint fk_athlete_academy foreign key (academy_id) references sports_academies(id) on delete set null;
alter table sports_match_performances
  add constraint fk_perf_match foreign key (match_id) references sports_matches(id) on delete cascade;
backend sets the claim)
create or replace function sports_auth_uid() returns uuid as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$ language sql stable;
create or replace function sports_is_minor(a_dob date) returns boolean as $$
  select a_dob is not null and a_dob > (current_date - interval '18 years');
$$ language sql immutable;
create or replace function sports_has_parent_consent(p_athlete uuid) returns boolean as $$
  select exists (
    select 1 from sports_parent_links pl
    where pl.athlete_id = p_athlete
      and pl.parent_user_id = sports_auth_uid()
      and pl.consent = true);
$$ language sql stable security definer set search_path = public;
create or replace function sports_is_linked_academy(p_academy uuid) returns boolean as $$
  select p_academy is not null and (
    exists (select 1 from sports_academies ac
            where ac.id = p_academy and ac.owner_user_id = sports_auth_uid())
    or exists (select 1 from sports_coaches co
            where co.user_id = sports_auth_uid() and co.academy_id = p_academy));
$$ language sql stable security definer set search_path = public;
create or replace function sports_has_active_grant(p_athlete uuid) returns boolean as $$
  select exists (
    select 1 from sports_data_access_grants g
    where g.athlete_id = p_athlete
      and g.grantee_id = sports_auth_uid()
      and g.revoked_at is null);
$$ language sql stable security definer set search_path = public;
alter table sports_athletes           enable row level security;
alter table sports_athlete_stats      enable row level security;
alter table sports_match_performances enable row level security;
alter table sports_media              enable row level security;
alter table sports_data_access_grants enable row level security;
alter table sports_parent_links       enable row level security;
self update
create policy users_self_read on sports_users for select
  using (id = sports_auth_uid() or sports_is_staff());
drop policy if exists users_self_update on sports_users;
create policy users_self_update on sports_users for update
  using (id = sports_auth_uid());
drop policy if exists athletes_self_write on sports_athletes;
create policy athletes_self_write on sports_athletes for update
  using (user_id = sports_auth_uid() or sports_is_staff());
drop policy if exists athletes_self_insert on sports_athletes;
create policy athletes_self_insert on sports_athletes for insert
  with check (user_id = sports_auth_uid() or sports_is_staff());
drop policy if exists perf_follow_athlete on sports_match_performances;
create policy perf_follow_athlete on sports_match_performances for select
  using (sports_can_read_athlete(athlete_id));
drop policy if exists media_follow_athlete on sports_media;
create policy media_follow_athlete on sports_media for select
  using (sports_can_read_athlete(athlete_id));
drop policy if exists grants_visible on sports_data_access_grants;
create policy grants_visible on sports_data_access_grants for select
  using (sports_is_staff() or grantee_id = sports_auth_uid() or sports_owns_athlete(athlete_id));
drop policy if exists grants_write on sports_data_access_grants;
create policy grants_write on sports_data_access_grants for all
  using (sports_is_staff() or sports_owns_athlete(athlete_id))
  with check (sports_is_staff() or sports_owns_athlete(athlete_id));
parent writes consent
create policy parentlinks_visible on sports_parent_links for select
  using (sports_is_staff() or parent_user_id = sports_auth_uid() or sports_owns_athlete(athlete_id));
drop policy if exists parentlinks_write on sports_parent_links;
create policy parentlinks_write on sports_parent_links for all
  using (parent_user_id = sports_auth_uid() or sports_is_staff())
  with check (parent_user_id = sports_auth_uid() or sports_is_staff());
staff/verifier see all;
subjects see their own.
-- Verification stays human-in-the-loop;
ed25519 sig via the Atlas interface (CW13).
-- =====================================================================

-- Is the current user a verifier (or admin)? (verifier is the human-in-loop role)
create or replace function sports_is_verifier() returns boolean as $$
  select exists (
    select 1 from sports_users u
    where u.id = sports_auth_uid()
      and (u.role_flags && array['verifier','admin']::text[]));
$$ language sql stable security definer set search_path = public;
alter table sports_verifications enable row level security;
the subject sees
-- their own pending/rejected;
verifiers/admins see everything for the queue.
create policy verifications_read on sports_verifications for select
using (
  status = 'human_verified'
  or sports_is_verifier()
  or sports_owns_verification(entity_type, entity_id)
);
the rights-holder APPROVES)
--   • minor → parent CO-CONSENT enforced at the DB (a minor cannot self-grant)
--   • immutable consent audit trail (compliance for minor data)
-- Honest-scope: minors stay non-discoverable;
approval is the ONLY path that
-- creates a grant for a minor, and only a consented parent may approve it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- ACCESS REQUESTS — a grantee asks for access;
the rights-holder decides.
-- This is the missing inbound half of data_access_grants: today a grant can
-- only be created top-down by the owner. R2 adds the request → approve flow.
-- ---------------------------------------------------------------------
create table sports_access_requests (
  id           uuid primary key default gen_random_uuid(),
  athlete_id   uuid not null references sports_athletes(id) on delete cascade,
  requester_id uuid not null references sports_users(id)    on delete cascade,
  scope        text not null check (scope in ('profile','stats','media','full')),
  reason       text,
  status       text not null default 'pending'
               check (status in ('pending','approved','denied','withdrawn')),
  decided_by   uuid references sports_users(id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
re-request allowed after a decision
create unique index areq_one_pending on sports_access_requests (athlete_id, requester_id, scope)
  where status = 'pending';
create index on sports_access_requests (athlete_id, status);
create index on sports_access_requests (requester_id);
create index on sports_consent_audit (athlete_id, ts);
alter table sports_consent_audit   enable row level security;
the rights-holder (athlete/parent/staff)
-- sees requests against their athlete. (Uses definer helpers — no recursion.)
create policy areq_visible on sports_access_requests for select
using (
  sports_is_staff()
  or requester_id = sports_auth_uid()
  or sports_owns_athlete(athlete_id)                 -- adult athlete or their own row
  or sports_has_parent_consent(athlete_id)           -- consented parent of a minor
);
drop policy if exists areq_requester_withdraw on sports_access_requests;
create policy areq_requester_withdraw on sports_access_requests for update
using (requester_id = sports_auth_uid())
with check (requester_id = sports_auth_uid() and status = 'withdrawn');
nobody updates/deletes (append-only).
create policy audit_visible on sports_consent_audit for select
using (sports_is_staff() or sports_owns_athlete(athlete_id) or sports_has_parent_consent(athlete_id));
drop policy if exists audit_append on sports_consent_audit;
create policy audit_append on sports_consent_audit for insert
with check (actor_id = sports_auth_uid() or sports_is_staff());
drop policy if exists grants_write on sports_data_access_grants;
create policy grants_write on sports_data_access_grants for all
  using (sports_can_approve_for(athlete_id))
  with check (sports_can_approve_for(athlete_id));
it does not flip minors discoverable. The read-side gate in
-- 002 is unchanged. DK + counsel still own the discoverable flip.
-- =====================================================================

-- ============================================================
-- 005_scope_grants.sql
-- ============================================================
-- =====================================================================
-- DCS SPORTS · MIGRATION 005 · SCOPE-AWARE GRANT ENFORCEMENT (R2 follow-up, CW9)
-- Today a grant of ANY scope exposes the whole athlete row + all child tables.
-- The `scope` column (profile|stats|media|full) was recorded but not enforced.
-- 005 makes grant-based reads scope-aware:
--   • stats  (sports_athlete_stats, sports_match_performances) require scope stats|full
--   • media  (sports_media)                                    require scope media|full
--   • the athlete profile row, via a grant, requires scope profile|full
-- Owner / consented-parent / linked-academy / staff keep FULL access (scope is
-- only a constraint on GRANT-based, i.e. scout, access).
--
-- PRIVACY POSTURE (default = A, privacy-forward): a *discoverable* athlete is
-- findable at the PROFILE level by authenticated users, but STATS and MEDIA
-- require an explicit scoped grant — even for discoverable adults. This closes
-- the "discoverability exposes everything" gap. Flip CLAUSE_DISCOVERABLE_CHILD
-- below to revert to Option B (discoverable => stats/media visible w/o grant).
-- Minor discoverability remains DARK regardless.
-- =====================================================================

-- scope check: an active grant whose scope satisfies the requirement (or 'full')
create or replace function sports_has_grant_scope(p_athlete uuid, p_scope text)
returns boolean as $$
  select exists (
    select 1 from sports_data_access_grants g
    where g.athlete_id = p_athlete
      and g.grantee_id = sports_auth_uid()
      and g.revoked_at is null
      and (g.scope = p_scope or g.scope = 'full'));
$$ language sql stable security definer set search_path = public;
scope never constrains them.
create or replace function sports_has_full_athlete_access(p_athlete uuid)
returns boolean as $$
  select exists (
    select 1 from sports_athletes a
    where a.id = p_athlete and (
      sports_is_staff()
      or a.user_id = sports_auth_uid()
      or sports_has_parent_consent(a.id)
      or sports_is_linked_academy(a.academy_id)
    ));
$$ language sql stable security definer set search_path = public;
drop policy if exists stats_scope_read on sports_athlete_stats;
create policy stats_scope_read on sports_athlete_stats for select
  using (sports_can_read_child(athlete_id, 'stats'));
drop policy if exists perf_follow_athlete on sports_match_performances;
drop policy if exists perf_scope_read on sports_match_performances;
create policy perf_scope_read on sports_match_performances for select
  using (sports_can_read_child(athlete_id, 'stats'));
drop policy if exists media_scope_read on sports_media;
create policy media_scope_read on sports_media for select
  using (sports_can_read_child(athlete_id, 'media'));
but when access
-- is via a GRANT (the minor case, or a private/academy athlete), the grant must
-- include profile scope. We rewrite the charter read policy to thread scope
-- through the grant branch only.
-- ---------------------------------------------------------------------
drop policy if exists athletes_charter_read on sports_athletes;
drop policy if exists athletes_charter_read on sports_athletes;
create policy athletes_charter_read on sports_athletes for select
using (
  sports_is_staff()
  or user_id = sports_auth_uid()
  or sports_has_parent_consent(id)
  or sports_is_linked_academy(academy_id)
  -- public: anyone may read non-minor public rows at profile level
  or ( visibility = 'public'
       and (not sports_is_minor(dob) or sports_has_grant_scope(id, 'profile')) )
  -- discoverable: authenticated only;
minors require a profile-scoped grant
  or ( visibility = 'discoverable'
       and sports_auth_uid() is not null
       and (not sports_is_minor(dob) or sports_has_grant_scope(id, 'profile')) )
  -- private/academy athletes become readable to a grantee with profile|full
  or ( visibility in ('private','academy')
       and sports_has_grant_scope(id, 'profile') )
);
create or replace function sports_has_grant_scope(p_athlete uuid, p_scope text)
returns boolean as $$
  select exists (
    select 1 from sports_data_access_grants g
    where g.athlete_id = p_athlete
      and g.grantee_id = sports_auth_uid()
      and sports_grant_is_active(g.revoked_at, g.expires_at)
      and (g.scope = p_scope or g.scope = 'full'));
$$ language sql stable security definer set search_path = public;
RLS still enforces live.
-- ---------------------------------------------------------------------
create or replace function sports_sweep_expired_grants() returns integer as $$
  with swept as (
    update sports_data_access_grants
       set revoked_at = now()
     where revoked_at is null
       and expires_at is not null
       and expires_at <= now()
    returning 1)
  select count(*)::int from swept;
$$ language sql security definer set search_path = public;
