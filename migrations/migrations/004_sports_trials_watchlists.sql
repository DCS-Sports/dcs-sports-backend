-- 004_sports_trials_watchlists.sql
-- PROPOSED by CW16 — for CW9 review/apply (CW9 owns schema + RLS).
-- Fills the two S1 gaps blocking M-S3: Verified Trials Network + scout watchlists.
-- Style matches 001_sports_schema.sql; RLS posture matches 002/003 (athlete
-- discoverability + minor-gating respected via existing helper functions).

-- ============ VERIFIED TRIALS NETWORK (CW14 orchestration) ============
create table if not exists sports_trials (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  host_user_id uuid references sports_users(id),     -- academy/scout/league organizer
  sport text not null,
  level text,                                         -- district/state/national
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
  scores_json jsonb,                                  -- per-drill measured scores
  selected boolean not null default false,            -- selection outcome
  selection_note text,
  recorded_by uuid references sports_users(id),       -- human action
  recorded_at timestamptz not null default now(),
  unique (trial_id, athlete_id)
);

-- ============ SCOUT WATCHLISTS (CW14) ============
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

-- ============ RLS ============
alter table sports_trials enable row level security;
alter table sports_trial_registrations enable row level security;
alter table sports_trial_results enable row level security;
alter table sports_watchlists enable row level security;
alter table sports_watchlist_items enable row level security;

-- Trials: discoverable/public visible to all authed; private only to host.
create policy trials_read on sports_trials for select
  using (visibility in ('discoverable','public') or host_user_id = sports_auth_uid());

-- Registrations: athlete sees own; host sees their trial's; reuse can_read_athlete
-- so a scout cannot enumerate minor registrations they may not see.
create policy trial_reg_read on sports_trial_registrations for select
  using (
    sports_owns_athlete(athlete_id)
    or exists (select 1 from sports_trials t where t.id = trial_id and t.host_user_id = sports_auth_uid())
    or sports_can_read_athlete(athlete_id)
  );

-- Results: same readability as registrations; selection is a human-recorded fact.
create policy trial_res_read on sports_trial_results for select
  using (
    sports_owns_athlete(athlete_id)
    or exists (select 1 from sports_trials t where t.id = trial_id and t.host_user_id = sports_auth_uid())
    or sports_can_read_athlete(athlete_id)
  );

-- Watchlists: a scout sees only their own lists + items.
create policy watchlist_read on sports_watchlists for select
  using (scout_user_id = sports_auth_uid());
create policy watchlist_items_read on sports_watchlist_items for select
  using (exists (select 1 from sports_watchlists w where w.id = watchlist_id and w.scout_user_id = sports_auth_uid()));

-- NOTE: writes go via SERVICE_ROLE (bypasses RLS) per the established pattern.
-- These SELECT policies guard client/anon reads. CW9: review the can_read_athlete
-- joins against your final helper signatures before applying.
