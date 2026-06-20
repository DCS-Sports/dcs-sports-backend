-- 005_sports_trials_reconciled.sql
-- CANONICAL trials reconciliation (mandate ruling: CW16 schema wins).
-- Supersedes 004. Resolves the CW14/CW16 sports_trials conflict:
--   canonical = uuid id + host_user_id + visibility.
-- Safe to run on the live `dcs-sports` Supabase. CW9 applies.
--
-- Strategy: if a conflicting CW14 sports_trials (text id / organizer_user_id)
-- exists with NO rows, drop it and create canonical. If it has rows, abort with
-- a clear notice so data isn't silently lost (CW14 must export first).

do $$
declare
  has_table boolean;
  id_type text;
  row_count bigint;
begin
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'sports_trials'
  ) into has_table;

  if has_table then
    select data_type into id_type
      from information_schema.columns
      where table_schema = 'public' and table_name = 'sports_trials' and column_name = 'id';

    if id_type <> 'uuid' then
      execute 'select count(*) from sports_trials' into row_count;
      if row_count > 0 then
        raise exception 'sports_trials has % rows with non-uuid id. Export + clear before reconciling (no silent data loss).', row_count;
      end if;
      raise notice 'Dropping empty non-canonical sports_trials (id type=%) to reconcile.', id_type;
      drop table if exists sports_trial_results cascade;
      drop table if exists sports_trial_registrations cascade;
      drop table if exists sports_trials cascade;
    end if;
  end if;
end $$;

-- ============ CANONICAL VERIFIED TRIALS NETWORK ============
create table if not exists sports_trials (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  host_user_id uuid references sports_users(id),     -- canonical (NOT organizer_user_id)
  sport text not null,
  level text,
  venue text,
  scheduled_at timestamptz,
  visibility text not null default 'discoverable'
    check (visibility in ('private','discoverable','public')),
  status text not null default 'open'
    check (status in ('open','closed','completed','cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists sports_trial_registrations (
  id uuid primary key default gen_random_uuid(),
  trial_id uuid not null references sports_trials(id) on delete cascade,
  athlete_id uuid not null references sports_athletes(id) on delete cascade,
  registered_at timestamptz not null default now(),
  status text not null default 'registered'
    check (status in ('registered','withdrawn','attended','no_show')),
  unique (trial_id, athlete_id)
);

create table if not exists sports_trial_results (
  id uuid primary key default gen_random_uuid(),
  trial_id uuid not null references sports_trials(id) on delete cascade,
  athlete_id uuid not null references sports_athletes(id) on delete cascade,
  scores_json jsonb,
  selected boolean not null default false,
  selection_note text,
  recorded_by uuid references sports_users(id),
  recorded_at timestamptz not null default now(),
  unique (trial_id, athlete_id)
);

create table if not exists sports_watchlists (
  id uuid primary key default gen_random_uuid(),
  scout_user_id uuid not null references sports_users(id) on delete cascade,
  name text not null default 'Default',
  created_at timestamptz not null default now()
);

create table if not exists sports_watchlist_items (
  id uuid primary key default gen_random_uuid(),
  watchlist_id uuid not null references sports_watchlists(id) on delete cascade,
  athlete_id uuid not null references sports_athletes(id) on delete cascade,
  added_at timestamptz not null default now(),
  note text,
  unique (watchlist_id, athlete_id)
);

-- ============ COMPAT VIEW (eases CW14 migration) ============
-- CW14 code that still references organizer_user_id can read this view while
-- it migrates column names. Drop once CW14 is fully on host_user_id.
create or replace view sports_trials_compat as
  select id, name, host_user_id as organizer_user_id, sport, level, venue,
         scheduled_at, visibility, status, created_at
  from sports_trials;

-- ============ RLS ============
alter table sports_trials enable row level security;
alter table sports_trial_registrations enable row level security;
alter table sports_trial_results enable row level security;
alter table sports_watchlists enable row level security;
alter table sports_watchlist_items enable row level security;

create policy trials_read on sports_trials for select
  using (visibility in ('discoverable','public') or host_user_id = sports_auth_uid());

create policy trial_reg_read on sports_trial_registrations for select
  using (
    sports_owns_athlete(athlete_id)
    or exists (select 1 from sports_trials t where t.id = trial_id and t.host_user_id = sports_auth_uid())
    or sports_can_read_athlete(athlete_id)
  );

create policy trial_res_read on sports_trial_results for select
  using (
    sports_owns_athlete(athlete_id)
    or exists (select 1 from sports_trials t where t.id = trial_id and t.host_user_id = sports_auth_uid())
    or sports_can_read_athlete(athlete_id)
  );

create policy watchlist_read on sports_watchlists for select
  using (scout_user_id = sports_auth_uid());
create policy watchlist_items_read on sports_watchlist_items for select
  using (exists (select 1 from sports_watchlists w where w.id = watchlist_id and w.scout_user_id = sports_auth_uid()));

-- Writes via SERVICE_ROLE (bypasses RLS). SELECT policies guard client reads.
