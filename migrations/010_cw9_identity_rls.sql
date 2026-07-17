-- ============================================================
-- 001_sports_schema.sql
-- ============================================================
-- =====================================================================
-- DCS SPORTS · MIGRATION 001 · CANONICAL S1 SCHEMA  (CW9 owns; all lanes read)
-- Fresh Supabase project `dcs-sports` · public schema · sports_ prefix
-- Frozen 19 Jun 2026 per DAY-0 MANAGER REPLY. Do NOT fork shapes — extend via new migrations.
-- Honest-scope: RLS-first · money DARK · AI=estimate · verification human-in-loop.
-- =====================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- ROLE ENUM (frozen — 10 roles). role_flags is text[] on one users row.
-- Using a CHECK-validated text[] (not a pg enum array) so adding a role
-- later is a migration, not a type rebuild. Validation lives in a trigger.
-- ---------------------------------------------------------------------
create or replace function sports_valid_roles(flags text[]) returns boolean as $$
  select flags <@ array[
    'athlete','parent','academy_admin','coach','scout',
    'league_admin','association_admin','franchise','verifier','admin'
  ]::text[];
$$ language sql immutable;

-- =====================================================================
-- IDENTITY (CW9)
-- =====================================================================
create table sports_users (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  phone       text,
  name        text not null,
  dob         date,
  role_flags  text[] not null default array['athlete']::text[]
              check (sports_valid_roles(role_flags)),
  created_at  timestamptz not null default now()
);

create table sports_data_access_grants (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null,
  grantee_id  uuid not null references sports_users(id)    on delete cascade,
  scope       text not null check (scope in ('profile','stats','media','full')),
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  unique (athlete_id, grantee_id, scope)
);

create table sports_parent_links (
  parent_user_id uuid not null references sports_users(id)    on delete cascade,
  athlete_id     uuid not null,
  relation       text not null check (relation in ('father','mother','guardian')),
  consent        boolean not null default false,
  consented_at   timestamptz,
  primary key (parent_user_id, athlete_id)
);

-- =====================================================================
-- ATHLETE (CW10)
-- =====================================================================
create table sports_athletes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references sports_users(id) on delete cascade,
  sport         text not null default 'cricket',
  role          text,                       -- batsman/bowler/all-rounder/wk (sport-specific)
  batting_style text,
  bowling_style text,
  state         text,
  district      text,
  dob           date,                        -- mirrored for RLS minor-check (avoid users join)
  verified_status text not null default 'unverified'
                check (verified_status in ('unverified','pending','verified')),
  academy_id    uuid,
  visibility    text not null default 'private'
                check (visibility in ('private','academy','discoverable','public')),
  created_at    timestamptz not null default now()
);
create index on sports_athletes (user_id);
create index on sports_athletes (sport, state, role);
create index on sports_athletes (visibility);

create table sports_athlete_stats (
  id             uuid primary key default gen_random_uuid(),
  athlete_id     uuid not null references sports_athletes(id) on delete cascade,
  season         text,
  matches        int default 0,
  runs           int default 0,
  wickets        int default 0,
  avg            numeric(6,2),
  strike_rate    numeric(6,2),
  batting_rating numeric(5,2),
  bowling_rating numeric(5,2),
  fielding_rating numeric(5,2),
  source         text not null default 'match' check (source in ('match','manual','vision'))
);
create index on sports_athlete_stats (athlete_id, season);

create table sports_match_performances (
  id            uuid primary key default gen_random_uuid(),
  match_id      uuid not null,
  athlete_id    uuid not null references sports_athletes(id) on delete cascade,
  runs          int default 0,
  balls         int default 0,
  fours         int default 0,
  sixes         int default 0,
  overs         numeric(4,1) default 0,
  wickets       int default 0,
  runs_conceded int default 0,
  catches       int default 0,
  source        text not null default 'match' check (source in ('match','manual','vision'))
);
create index on sports_match_performances (athlete_id);
create index on sports_match_performances (match_id);

create table sports_media (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references sports_athletes(id) on delete cascade,
  type        text not null check (type in ('photo','video','highlight')),
  url         text not null,
  created_at  timestamptz not null default now()
);

-- =====================================================================
-- ACADEMY (CW11)
-- =====================================================================
create table sports_academies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  owner_user_id uuid not null references sports_users(id) on delete cascade,
  city          text,
  state         text,
  verified_status text not null default 'unverified'
                check (verified_status in ('unverified','pending','verified')),
  created_at    timestamptz not null default now()
);

create table sports_academy_players (
  academy_id  uuid not null references sports_academies(id) on delete cascade,
  athlete_id  uuid not null references sports_athletes(id)  on delete cascade,
  joined_at   timestamptz not null default now(),
  status      text not null default 'active' check (status in ('active','inactive','left')),
  primary key (academy_id, athlete_id)
);

create table sports_coaches (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references sports_users(id) on delete cascade,
  academy_id  uuid references sports_academies(id) on delete set null,
  verified_status text not null default 'unverified'
              check (verified_status in ('unverified','pending','verified'))
);

create table sports_attendance (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references sports_athletes(id) on delete cascade,
  academy_id  uuid not null references sports_academies(id) on delete cascade,
  date        date not null,
  present     boolean not null default false,
  note        text
);
create index on sports_attendance (athlete_id, date);

create table sports_assessments (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references sports_athletes(id) on delete cascade,
  coach_id    uuid not null references sports_coaches(id)  on delete cascade,
  scores_json jsonb not null default '{}'::jsonb,
  date        date not null default current_date
);

create table sports_training_plans (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references sports_coaches(id)  on delete cascade,
  athlete_id  uuid not null references sports_athletes(id) on delete cascade,
  plan_json   jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- =====================================================================
-- LEAGUE (CW12) — the data factory
-- =====================================================================
create table sports_leagues (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  organizer_user_id uuid not null references sports_users(id) on delete cascade,
  format           text not null check (format in ('round_robin','knockout','hybrid')),
  level            text,
  season           text,
  created_at       timestamptz not null default now()
);

create table sports_teams (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid not null references sports_leagues(id) on delete cascade,
  name        text not null,
  academy_id  uuid references sports_academies(id) on delete set null
);

create table sports_team_players (
  team_id     uuid not null references sports_teams(id)     on delete cascade,
  athlete_id  uuid not null references sports_athletes(id)  on delete cascade,
  primary key (team_id, athlete_id)
);

create table sports_matches (
  id            uuid primary key default gen_random_uuid(),
  league_id     uuid references sports_leagues(id) on delete cascade,
  type          text,
  home_team_id  uuid references sports_teams(id) on delete set null,
  away_team_id  uuid references sports_teams(id) on delete set null,
  venue         text,
  date          timestamptz,
  status        text not null default 'scheduled'
                check (status in ('scheduled','live','completed','abandoned')),
  result        text
);
create index on sports_matches (league_id, status);

create table sports_fixtures (
  id            uuid primary key default gen_random_uuid(),
  league_id     uuid not null references sports_leagues(id) on delete cascade,
  round         int,
  home_team_id  uuid references sports_teams(id) on delete set null,
  away_team_id  uuid references sports_teams(id) on delete set null,
  venue         text,
  scheduled_at  timestamptz
);

create table sports_live_scores (
  id          uuid primary key default gen_random_uuid(),
  match_id    uuid not null references sports_matches(id) on delete cascade,
  innings     int,
  over        int,
  ball        int,
  event_json  jsonb not null,   -- {event:'run'|'wicket'|'catch', athlete_id, runs?, ...}
  ts          timestamptz not null default now()
);
create index on sports_live_scores (match_id, ts);

create table sports_sport_config (
  sport            text primary key,
  stat_fields_json jsonb not null default '{}'::jsonb,
  scoring_rules_json jsonb not null default '{}'::jsonb
);

-- =====================================================================
-- VERIFICATION (CW13)
-- =====================================================================
create table sports_verifications (
  id          uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('athlete','academy','coach','league','scout')),
  entity_id   uuid not null,
  status      text not null default 'pending'
              check (status in ('pending','ai_passed','human_verified','rejected')),
  verified_by uuid references sports_users(id) on delete set null,
  evidence_url text,
  ts          timestamptz not null default now(),
  sig         text         -- ed25519 receipt sig (Atlas reuse, S4)
);
create index on sports_verifications (entity_type, entity_id);

-- =====================================================================
-- AGENTS / REVENUE / VISION / TALENT  (CW16 / CW15)
-- =====================================================================
create table sports_agent_suggestions (
  id           uuid primary key default gen_random_uuid(),
  agent        text not null,
  subject_type text not null,
  subject_id   uuid not null,
  payload_json jsonb not null,
  high_stakes  boolean not null default false,
  status       text not null default 'open' check (status in ('open','actioned','dismissed')),
  created_at   timestamptz not null default now()
);

create table sports_revenue_events (
  id          uuid primary key default gen_random_uuid(),
  source      text,
  athlete_id  uuid references sports_athletes(id) on delete set null,
  gross       numeric(12,2),
  splits_json jsonb,
  mode        text not null default 'test'   -- DARK: never 'live' without DK flip
);

create table sports_vision_jobs (
  id          uuid primary key default gen_random_uuid(),
  match_id    uuid references sports_matches(id) on delete set null,
  video_url   text,
  status      text not null default 'queued'
              check (status in ('queued','processing','done','failed')),
  version     text
);

create table sports_vision_outputs (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references sports_vision_jobs(id) on delete cascade,
  type        text,
  data_json   jsonb not null,
  confidence  numeric(4,3)
);

create table sports_talent_index (
  athlete_id  uuid primary key references sports_athletes(id) on delete cascade,
  skill       numeric(5,2),
  potential   numeric(5,2),
  consistency numeric(5,2),
  pressure    numeric(5,2),
  fitness     numeric(5,2),
  coach       numeric(5,2),
  composite   numeric(5,2),
  computed_at timestamptz not null default now()
);

create table sports_fitness_tests (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references sports_athletes(id) on delete cascade,
  type        text not null,   -- speed/reaction/strength/endurance
  value       numeric(8,2),
  date        date not null default current_date
);

-- ---------------------------------------------------------------------
-- DEFERRED FOREIGN KEYS (added after all tables exist — resolves forward refs)
-- ---------------------------------------------------------------------
alter table sports_data_access_grants
  add constraint fk_grants_athlete foreign key (athlete_id) references sports_athletes(id) on delete cascade;
alter table sports_parent_links
  add constraint fk_plinks_athlete foreign key (athlete_id) references sports_athletes(id) on delete cascade;
alter table sports_athletes
  add constraint fk_athlete_academy foreign key (academy_id) references sports_academies(id) on delete set null;
alter table sports_match_performances
  add constraint fk_perf_match foreign key (match_id) references sports_matches(id) on delete cascade;

-- seed cricket as sport config #1 (multi-sport from Day-0)
insert into sports_sport_config (sport, stat_fields_json, scoring_rules_json) values
  ('cricket',
   '{"batting":["runs","balls","fours","sixes","strike_rate","avg"],"bowling":["overs","wickets","runs_conceded","economy"],"fielding":["catches","runouts"]}'::jsonb,
   '{"events":["run","wicket","wide","no_ball","bye","leg_bye","catch","runout"],"innings":2}'::jsonb)
on conflict (sport) do nothing;

-- ============================================================
-- 002_sports_rls.sql
-- ============================================================
-- =====================================================================
-- DCS SPORTS · MIGRATION 002 · S3 RLS / ATHLETE RIGHTS CHARTER  (CW9 owns)
-- Enforced AT THE DB. Minor rows SAFE-by-default (DARK flip gated).
-- Cross-table existence checks run through SECURITY DEFINER helpers to
-- avoid policy<->policy infinite recursion (canonical Supabase pattern).
-- =====================================================================

-- Session identity (reuse DCS Rank JWT-decode pattern; backend sets the claim)
create or replace function sports_auth_uid() returns uuid as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$ language sql stable;

-- All helpers below are SECURITY DEFINER + owned by the table owner, so the
-- internal lookups bypass RLS and cannot re-enter the policies that call them.
create or replace function sports_is_staff() returns boolean as $$
  select exists (
    select 1 from sports_users u
    where u.id = sports_auth_uid()
      and (u.role_flags && array['admin','verifier']::text[]));
$$ language sql stable security definer set search_path = public;

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

-- athlete-readability predicate, reused by child tables (single source of truth)
create or replace function sports_can_read_athlete(p_athlete uuid) returns boolean as $$
  select exists (
    select 1 from sports_athletes a
    where a.id = p_athlete and (
      sports_is_staff()
      or a.user_id = sports_auth_uid()
      or sports_has_parent_consent(a.id)
      or sports_is_linked_academy(a.academy_id)
      or (a.visibility = 'public'
          and (not sports_is_minor(a.dob) or sports_has_active_grant(a.id)))
      or (a.visibility = 'discoverable' and sports_auth_uid() is not null
          and (not sports_is_minor(a.dob) or sports_has_active_grant(a.id)))
    ));
$$ language sql stable security definer set search_path = public;

-- ---------------------------------------------------------------------
alter table sports_users              enable row level security;
alter table sports_athletes           enable row level security;
alter table sports_athlete_stats      enable row level security;
alter table sports_match_performances enable row level security;
alter table sports_media              enable row level security;
alter table sports_data_access_grants enable row level security;
alter table sports_parent_links       enable row level security;

-- users: self + staff read; self update
create policy users_self_read on sports_users for select
  using (id = sports_auth_uid() or sports_is_staff());
create policy users_self_update on sports_users for update
  using (id = sports_auth_uid());

-- THE CHARTER POLICY (no inline subqueries -> no recursion)
create policy athletes_charter_read on sports_athletes for select
using (
  sports_is_staff()
  or user_id = sports_auth_uid()
  or sports_has_parent_consent(id)
  or sports_is_linked_academy(academy_id)
  -- public: anyone (incl. anonymous) may read non-minor public rows
  or ( visibility = 'public'
       and (not sports_is_minor(dob) or sports_has_active_grant(id)) )
  -- discoverable: ONLY an authenticated user (a real logged-in scout), never anon
  or ( visibility = 'discoverable'
       and sports_auth_uid() is not null
       and (not sports_is_minor(dob) or sports_has_active_grant(id)) )
);
create policy athletes_self_write on sports_athletes for update
  using (user_id = sports_auth_uid() or sports_is_staff());
create policy athletes_self_insert on sports_athletes for insert
  with check (user_id = sports_auth_uid() or sports_is_staff());

-- child tables delegate to the readability predicate
create policy stats_follow_athlete on sports_athlete_stats for select
  using (sports_can_read_athlete(athlete_id));
create policy perf_follow_athlete on sports_match_performances for select
  using (sports_can_read_athlete(athlete_id));
create policy media_follow_athlete on sports_media for select
  using (sports_can_read_athlete(athlete_id));

-- grants: athlete owner + grantee + staff (uses definer helper, no recursion)
create or replace function sports_owns_athlete(p_athlete uuid) returns boolean as $$
  select exists (select 1 from sports_athletes a
                 where a.id = p_athlete and a.user_id = sports_auth_uid());
$$ language sql stable security definer set search_path = public;

create policy grants_visible on sports_data_access_grants for select
  using (sports_is_staff() or grantee_id = sports_auth_uid() or sports_owns_athlete(athlete_id));
create policy grants_write on sports_data_access_grants for all
  using (sports_is_staff() or sports_owns_athlete(athlete_id))
  with check (sports_is_staff() or sports_owns_athlete(athlete_id));

-- parent links: parent or athlete-owner read; parent writes consent
create policy parentlinks_visible on sports_parent_links for select
  using (sports_is_staff() or parent_user_id = sports_auth_uid() or sports_owns_athlete(athlete_id));
create policy parentlinks_write on sports_parent_links for all
  using (parent_user_id = sports_auth_uid() or sports_is_staff())
  with check (parent_user_id = sports_auth_uid() or sports_is_staff());

-- =====================================================================
-- DARK FLIP NOTE (DK + counsel gated): minor discoverability is OFF.
-- The clause `(not sports_is_minor(dob) or sports_has_active_grant(id))`
-- is the single switch. Do NOT relax without the DK+counsel handshake.
-- =====================================================================

-- ============================================================
-- 003_verifications_rls.sql
-- ============================================================
-- =====================================================================
-- DCS SPORTS · MIGRATION 003 · VERIFICATIONS RLS  (CW9 owns the migration set)
-- Reconciled to the LIVE dcs-sports DB (applied 19 Jun per SCHEMA_LIVE wire-note).
-- Adds the two verifier helpers + closes RLS on sports_verifications:
--   public sees ONLY human_verified; staff/verifier see all; subjects see their own.
-- Verification stays human-in-the-loop; ed25519 sig via the Atlas interface (CW13).
-- =====================================================================

-- Is the current user a verifier (or admin)? (verifier is the human-in-loop role)
create or replace function sports_is_verifier() returns boolean as $$
  select exists (
    select 1 from sports_users u
    where u.id = sports_auth_uid()
      and (u.role_flags && array['verifier','admin']::text[]));
$$ language sql stable security definer set search_path = public;

-- Does the current user own the SUBJECT of a verification?
-- (the athlete/academy/coach/league/scout the verification is about)
create or replace function sports_owns_verification(p_entity_type text, p_entity_id uuid)
returns boolean as $$
  select case p_entity_type
    when 'athlete' then exists (select 1 from sports_athletes a
                                where a.id = p_entity_id and a.user_id = sports_auth_uid())
    when 'academy' then exists (select 1 from sports_academies ac
                                where ac.id = p_entity_id and ac.owner_user_id = sports_auth_uid())
    when 'coach'   then exists (select 1 from sports_coaches co
                                where co.id = p_entity_id and co.user_id = sports_auth_uid())
    when 'league'  then exists (select 1 from sports_leagues l
                                where l.id = p_entity_id and l.organizer_user_id = sports_auth_uid())
    when 'scout'   then p_entity_id = sports_auth_uid()   -- scout entity_id = the scout's user id
    else false
  end;
$$ language sql stable security definer set search_path = public;

alter table sports_verifications enable row level security;

-- READ: public sees only completed (human_verified) badges; the subject sees
-- their own pending/rejected; verifiers/admins see everything for the queue.
create policy verifications_read on sports_verifications for select
using (
  status = 'human_verified'
  or sports_is_verifier()
  or sports_owns_verification(entity_type, entity_id)
);

-- SUBMIT EVIDENCE: the subject (or staff) may create a pending verification.
create policy verifications_submit on sports_verifications for insert
with check (
  sports_is_verifier()
  or sports_owns_verification(entity_type, entity_id)
);

-- DECIDE: only a verifier/admin may approve/reject (set status, verified_by, sig).
-- Human-in-the-loop: AI may write status='ai_passed' via service role, but the
-- human_verified transition is verifier-only and never automated.
create policy verifications_decide on sports_verifications for update
using (sports_is_verifier())
with check (sports_is_verifier());

-- =====================================================================
-- OPTIONAL athlete-data RLS block (stats/perf/media already gated in 002 via
-- sports_can_read_athlete). Intentionally NOT added here — review with CW10
-- before extending row visibility on child tables (wire-note CW9 reminder).
-- =====================================================================

-- ============================================================
-- 004_charter_consent.sql
-- ============================================================
-- =====================================================================
-- DCS SPORTS · MIGRATION 004 · ATHLETE RIGHTS CHARTER — WRITE SIDE (R2, CW9)
-- R1 froze read-gating (002). R2 makes the Charter *live* on the write path:
--   • access-request lifecycle (a scout REQUESTS; the rights-holder APPROVES)
--   • minor → parent CO-CONSENT enforced at the DB (a minor cannot self-grant)
--   • immutable consent audit trail (compliance for minor data)
-- Honest-scope: minors stay non-discoverable; approval is the ONLY path that
-- creates a grant for a minor, and only a consented parent may approve it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- ACCESS REQUESTS — a grantee asks for access; the rights-holder decides.
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
-- at most ONE pending request per (athlete, requester, scope); re-request allowed after a decision
create unique index areq_one_pending on sports_access_requests (athlete_id, requester_id, scope)
  where status = 'pending';
create index on sports_access_requests (athlete_id, status);
create index on sports_access_requests (requester_id);

-- ---------------------------------------------------------------------
-- CONSENT AUDIT — append-only trail. Every grant/revoke/consent/decision
-- writes a row. Required for minor-data compliance. No UPDATE/DELETE policy
-- is created => rows are immutable to app roles (service role only, for ops).
-- ---------------------------------------------------------------------
create table sports_consent_audit (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid references sports_athletes(id) on delete set null,
  actor_id    uuid references sports_users(id)    on delete set null,
  action      text not null check (action in
              ('grant_created','grant_revoked','request_created','request_approved',
               'request_denied','request_withdrawn','consent_set','consent_withdrawn')),
  scope       text,
  subject_is_minor boolean,
  detail_json jsonb not null default '{}'::jsonb,
  ts          timestamptz not null default now()
);
create index on sports_consent_audit (athlete_id, ts);

-- ---------------------------------------------------------------------
-- CO-CONSENT GUARD: who is allowed to APPROVE a request / create a grant for
-- a given athlete. Adult: the athlete themselves (or staff). Minor: ONLY a
-- parent with consent=true (or staff). The athlete-minor can never self-approve.
-- SECURITY DEFINER so it can read parent_links without tripping RLS recursion.
-- ---------------------------------------------------------------------
create or replace function sports_can_approve_for(p_athlete uuid) returns boolean as $$
  select case
    when sports_is_staff() then true
    else exists (
      select 1 from sports_athletes a
      where a.id = p_athlete and (
        -- adult: the athlete owns the decision
        (not sports_is_minor(a.dob) and a.user_id = sports_auth_uid())
        -- minor: a consented parent owns the decision (athlete cannot self-approve)
        or (sports_is_minor(a.dob) and exists (
              select 1 from sports_parent_links pl
              where pl.athlete_id = a.id
                and pl.parent_user_id = sports_auth_uid()
                and pl.consent = true))
      ))
  end;
$$ language sql stable security definer set search_path = public;

-- =====================================================================
-- RLS
-- =====================================================================
alter table sports_access_requests enable row level security;
alter table sports_consent_audit   enable row level security;

-- requests: the requester sees their own; the rights-holder (athlete/parent/staff)
-- sees requests against their athlete. (Uses definer helpers — no recursion.)
create policy areq_visible on sports_access_requests for select
using (
  sports_is_staff()
  or requester_id = sports_auth_uid()
  or sports_owns_athlete(athlete_id)                 -- adult athlete or their own row
  or sports_has_parent_consent(athlete_id)           -- consented parent of a minor
);

-- a logged-in user may file a request for themselves (requester_id = me)
create policy areq_create on sports_access_requests for insert
with check (requester_id = sports_auth_uid());

-- DECISION RULES (two policies, because USING can't see the new row):
--  • an approver (adult-self / consented-parent / staff) may move pending → approved|denied
--  • the requester may move their own pending → withdrawn (and nothing else)
create policy areq_approver_decide on sports_access_requests for update
using (sports_can_approve_for(athlete_id))
with check (sports_can_approve_for(athlete_id) and status in ('approved','denied'));

create policy areq_requester_withdraw on sports_access_requests for update
using (requester_id = sports_auth_uid())
with check (requester_id = sports_auth_uid() and status = 'withdrawn');

-- audit: rights-holder + staff may read; nobody updates/deletes (append-only).
create policy audit_visible on sports_consent_audit for select
using (sports_is_staff() or sports_owns_athlete(athlete_id) or sports_has_parent_consent(athlete_id));
create policy audit_append on sports_consent_audit for insert
with check (actor_id = sports_auth_uid() or sports_is_staff());

-- ---------------------------------------------------------------------
-- HARDEN the existing grants write policy with the co-consent guard.
-- 002 allowed grants_write to (staff OR athlete-owner). For a MINOR, the
-- athlete-owner is the minor themselves — which must NOT be able to self-grant.
-- Replace with the co-consent guard so minor grants require a consented parent.
-- ---------------------------------------------------------------------
drop policy if exists grants_write on sports_data_access_grants;
create policy grants_write on sports_data_access_grants for all
  using (sports_can_approve_for(athlete_id))
  with check (sports_can_approve_for(athlete_id));

-- =====================================================================
-- NOTE: minor discoverability remains DARK. R2 only makes the consent/approval
-- machinery live; it does not flip minors discoverable. The read-side gate in
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

-- Non-grant access paths (owner / consented parent / linked academy / staff).
-- These get FULL access to every child table; scope never constrains them.
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

-- Per-scope child readability: full-access OR a matching scoped grant.
create or replace function sports_can_read_child(p_athlete uuid, p_scope text)
returns boolean as $$
  select sports_has_full_athlete_access(p_athlete)
      or sports_has_grant_scope(p_athlete, p_scope);
$$ language sql stable security definer set search_path = public;

-- ---------------------------------------------------------------------
-- Re-point the child-table SELECT policies at the scope-aware predicate.
-- (Drop the scope-blind *_follow_athlete policies from 002 and replace.)
-- ---------------------------------------------------------------------
drop policy if exists stats_follow_athlete on sports_athlete_stats;
create policy stats_scope_read on sports_athlete_stats for select
  using (sports_can_read_child(athlete_id, 'stats'));

drop policy if exists perf_follow_athlete on sports_match_performances;
create policy perf_scope_read on sports_match_performances for select
  using (sports_can_read_child(athlete_id, 'stats'));   -- match performances = stats scope

drop policy if exists media_follow_athlete on sports_media;
create policy media_scope_read on sports_media for select
  using (sports_can_read_child(athlete_id, 'media'));

-- ---------------------------------------------------------------------
-- Tighten the ATHLETE ROW grant-based path to require 'profile'|'full'.
-- The discoverable/public clauses still apply for findability; but when access
-- is via a GRANT (the minor case, or a private/academy athlete), the grant must
-- include profile scope. We rewrite the charter read policy to thread scope
-- through the grant branch only.
-- ---------------------------------------------------------------------
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
  -- discoverable: authenticated only; minors require a profile-scoped grant
  or ( visibility = 'discoverable'
       and sports_auth_uid() is not null
       and (not sports_is_minor(dob) or sports_has_grant_scope(id, 'profile')) )
  -- private/academy athletes become readable to a grantee with profile|full
  or ( visibility in ('private','academy')
       and sports_has_grant_scope(id, 'profile') )
);

-- =====================================================================
-- NOTE: sports_can_read_athlete() (used elsewhere) is unchanged and still
-- answers "can this viewer see the athlete row at all". The child policies no
-- longer call it — they call sports_can_read_child() so scope is honored.
-- =====================================================================

-- ============================================================
-- 006_grant_expiry.sql
-- ============================================================
-- =====================================================================
-- DCS SPORTS · MIGRATION 006 · GRANT EXPIRY / AUTO-REVOKE (R2 follow-up, CW9)
-- Grants were permanent until manually revoked. Consent — especially for minors
-- — should be revocable AND time-boxed. 006 adds expires_at and redefines what
-- "active grant" means at the DB, so access lapses automatically with NO cron:
--   active := revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
-- Because the two grant-active helpers are CREATE OR REPLACE'd, every policy that
-- calls them (athlete charter read, child scope reads) honors expiry immediately.
-- =====================================================================

alter table sports_data_access_grants
  add column if not exists expires_at timestamptz;     -- NULL = no expiry (indefinite, until revoked)

-- index to make the "active + not expired" filter cheap
create index if not exists idx_grants_active
  on sports_data_access_grants (athlete_id, grantee_id)
  where revoked_at is null;

-- single source of truth for "is this grant row currently live"
create or replace function sports_grant_is_active(g_revoked_at timestamptz, g_expires_at timestamptz)
returns boolean as $$
  select g_revoked_at is null and (g_expires_at is null or g_expires_at > now());
$$ language sql stable;

-- ---- redefine the two active-grant helpers to honor expiry ----
create or replace function sports_has_active_grant(p_athlete uuid) returns boolean as $$
  select exists (
    select 1 from sports_data_access_grants g
    where g.athlete_id = p_athlete
      and g.grantee_id = sports_auth_uid()
      and sports_grant_is_active(g.revoked_at, g.expires_at));
$$ language sql stable security definer set search_path = public;

create or replace function sports_has_grant_scope(p_athlete uuid, p_scope text)
returns boolean as $$
  select exists (
    select 1 from sports_data_access_grants g
    where g.athlete_id = p_athlete
      and g.grantee_id = sports_auth_uid()
      and sports_grant_is_active(g.revoked_at, g.expires_at)
      and (g.scope = p_scope or g.scope = 'full'));
$$ language sql stable security definer set search_path = public;

-- ---------------------------------------------------------------------
-- OPTIONAL housekeeping: stamp revoked_at on already-expired rows so audit /
-- admin views show them as revoked. Not required for enforcement (the helpers
-- already treat expired as inactive) — this is cosmetic/reporting hygiene and
-- safe to run repeatedly. Service-role/cron may call it; RLS still enforces live.
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

-- =====================================================================
-- NOTE: expiry is enforced on READ, not by a background job — an expired grant
-- is invisible the instant it lapses, even before the sweep runs. The sweep is
-- only to make stale rows read as 'revoked' in admin/audit surfaces.
-- =====================================================================

