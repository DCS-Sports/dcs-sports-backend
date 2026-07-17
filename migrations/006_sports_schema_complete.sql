-- DCS Sports — complete schema (idempotent, non-destructive).
-- Derived from what the backend code actually queries. CREATE TABLE IF NOT EXISTS +
-- ADD COLUMN IF NOT EXISTS: existing tables/data are never dropped or altered in place.
-- Run AFTER the existing trials/watchlists migrations (004/005). Pre-launch: no real data at risk.
-- NOTE: code uses sports_watchlists.scout_id + athlete_ids (denormalized) — differs from the
--       004/005 migration (scout_user_id + items table). This file matches the CODE.

create extension if not exists pgcrypto;

create table if not exists sports_users (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  name text,
  dob date,
  role_flags text[],
  created_at timestamptz default now()
);
alter table sports_users add column if not exists email text;
alter table sports_users add column if not exists phone text;
alter table sports_users add column if not exists name text;
alter table sports_users add column if not exists dob date;
alter table sports_users add column if not exists role_flags text[];
alter table sports_users add column if not exists created_at timestamptz default now();

create table if not exists sports_athletes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  sport text,
  role text,
  batting_style text,
  bowling_style text,
  state text,
  district text,
  dob date,
  verified_status text,
  academy_id uuid,
  visibility text,
  created_at timestamptz default now()
);
alter table sports_athletes add column if not exists user_id uuid;
alter table sports_athletes add column if not exists sport text;
alter table sports_athletes add column if not exists role text;
alter table sports_athletes add column if not exists batting_style text;
alter table sports_athletes add column if not exists bowling_style text;
alter table sports_athletes add column if not exists state text;
alter table sports_athletes add column if not exists district text;
alter table sports_athletes add column if not exists dob date;
alter table sports_athletes add column if not exists verified_status text;
alter table sports_athletes add column if not exists academy_id uuid;
alter table sports_athletes add column if not exists visibility text;
alter table sports_athletes add column if not exists created_at timestamptz default now();

create table if not exists sports_athlete_stats (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid,
  season text,
  matches integer,
  runs integer,
  wickets integer,
  avg numeric,
  strike_rate numeric,
  batting_rating numeric,
  bowling_rating numeric,
  fielding_rating numeric,
  source text
);
alter table sports_athlete_stats add column if not exists athlete_id uuid;
alter table sports_athlete_stats add column if not exists season text;
alter table sports_athlete_stats add column if not exists matches integer;
alter table sports_athlete_stats add column if not exists runs integer;
alter table sports_athlete_stats add column if not exists wickets integer;
alter table sports_athlete_stats add column if not exists avg numeric;
alter table sports_athlete_stats add column if not exists strike_rate numeric;
alter table sports_athlete_stats add column if not exists batting_rating numeric;
alter table sports_athlete_stats add column if not exists bowling_rating numeric;
alter table sports_athlete_stats add column if not exists fielding_rating numeric;
alter table sports_athlete_stats add column if not exists source text;

create table if not exists sports_matches (
  id uuid primary key default gen_random_uuid(),
  league_id uuid,
  type text,
  home_team_id uuid,
  away_team_id uuid,
  venue text,
  date date,
  status text,
  result text
);
alter table sports_matches add column if not exists league_id uuid;
alter table sports_matches add column if not exists type text;
alter table sports_matches add column if not exists home_team_id uuid;
alter table sports_matches add column if not exists away_team_id uuid;
alter table sports_matches add column if not exists venue text;
alter table sports_matches add column if not exists date date;
alter table sports_matches add column if not exists status text;
alter table sports_matches add column if not exists result text;

create table if not exists sports_match_performances (
  id uuid primary key default gen_random_uuid(),
  match_id uuid,
  athlete_id uuid,
  runs integer,
  balls integer,
  fours integer,
  sixes integer,
  overs integer,
  wickets integer,
  runs_conceded integer,
  catches integer,
  source text
);
alter table sports_match_performances add column if not exists match_id uuid;
alter table sports_match_performances add column if not exists athlete_id uuid;
alter table sports_match_performances add column if not exists runs integer;
alter table sports_match_performances add column if not exists balls integer;
alter table sports_match_performances add column if not exists fours integer;
alter table sports_match_performances add column if not exists sixes integer;
alter table sports_match_performances add column if not exists overs integer;
alter table sports_match_performances add column if not exists wickets integer;
alter table sports_match_performances add column if not exists runs_conceded integer;
alter table sports_match_performances add column if not exists catches integer;
alter table sports_match_performances add column if not exists source text;

create table if not exists sports_academy_players (
  id uuid primary key default gen_random_uuid(),
  academy_id uuid,
  athlete_id uuid,
  joined_at timestamptz default now(),
  status text
);
alter table sports_academy_players add column if not exists academy_id uuid;
alter table sports_academy_players add column if not exists athlete_id uuid;
alter table sports_academy_players add column if not exists joined_at timestamptz default now();
alter table sports_academy_players add column if not exists status text;

create table if not exists sports_attendance (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid,
  academy_id uuid,
  date date,
  present boolean,
  note text
);
alter table sports_attendance add column if not exists athlete_id uuid;
alter table sports_attendance add column if not exists academy_id uuid;
alter table sports_attendance add column if not exists date date;
alter table sports_attendance add column if not exists present boolean;
alter table sports_attendance add column if not exists note text;

create table if not exists sports_leagues (
  id uuid primary key default gen_random_uuid(),
  name text,
  organizer_user_id uuid,
  format text,
  level text,
  season text,
  sport text,
  max_overs integer,
  created_at timestamptz default now()
);
alter table sports_leagues add column if not exists name text;
alter table sports_leagues add column if not exists organizer_user_id uuid;
alter table sports_leagues add column if not exists format text;
alter table sports_leagues add column if not exists level text;
alter table sports_leagues add column if not exists season text;
alter table sports_leagues add column if not exists sport text;
alter table sports_leagues add column if not exists max_overs integer;
alter table sports_leagues add column if not exists created_at timestamptz default now();

create table if not exists sports_teams (
  id uuid primary key default gen_random_uuid(),
  league_id uuid,
  name text,
  academy_id uuid
);
alter table sports_teams add column if not exists league_id uuid;
alter table sports_teams add column if not exists name text;
alter table sports_teams add column if not exists academy_id uuid;

create table if not exists sports_fixtures (
  id uuid primary key default gen_random_uuid(),
  league_id uuid,
  round integer,
  home_team_id uuid,
  away_team_id uuid,
  venue text,
  scheduled_at timestamptz default now(),
  status text
);
alter table sports_fixtures add column if not exists league_id uuid;
alter table sports_fixtures add column if not exists round integer;
alter table sports_fixtures add column if not exists home_team_id uuid;
alter table sports_fixtures add column if not exists away_team_id uuid;
alter table sports_fixtures add column if not exists venue text;
alter table sports_fixtures add column if not exists scheduled_at timestamptz default now();
alter table sports_fixtures add column if not exists status text;

create table if not exists sports_live_scores (
  id uuid primary key default gen_random_uuid(),
  match_id uuid,
  innings integer,
  over integer,
  ball integer,
  event_json jsonb,
  ts timestamptz default now()
);
alter table sports_live_scores add column if not exists match_id uuid;
alter table sports_live_scores add column if not exists innings integer;
alter table sports_live_scores add column if not exists over integer;
alter table sports_live_scores add column if not exists ball integer;
alter table sports_live_scores add column if not exists event_json jsonb;
alter table sports_live_scores add column if not exists ts timestamptz default now();

create table if not exists sports_verifications (
  id uuid primary key default gen_random_uuid(),
  entity_type text,
  entity_id uuid,
  status text,
  verified_by text,
  evidence_url text,
  sig text,
  ts timestamptz default now()
);
alter table sports_verifications add column if not exists entity_type text;
alter table sports_verifications add column if not exists entity_id uuid;
alter table sports_verifications add column if not exists status text;
alter table sports_verifications add column if not exists verified_by text;
alter table sports_verifications add column if not exists evidence_url text;
alter table sports_verifications add column if not exists sig text;
alter table sports_verifications add column if not exists ts timestamptz default now();

create table if not exists sports_parent_links (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid,
  athlete_id uuid,
  relation text,
  consent boolean,
  consented_at timestamptz default now(),
  revoked_at timestamptz default now()
);
alter table sports_parent_links add column if not exists parent_user_id uuid;
alter table sports_parent_links add column if not exists athlete_id uuid;
alter table sports_parent_links add column if not exists relation text;
alter table sports_parent_links add column if not exists consent boolean;
alter table sports_parent_links add column if not exists consented_at timestamptz default now();
alter table sports_parent_links add column if not exists revoked_at timestamptz default now();

create table if not exists sports_data_access_grants (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid,
  grantee_id uuid,
  scope text,
  granted_at timestamptz default now(),
  revoked_at timestamptz default now()
);
alter table sports_data_access_grants add column if not exists athlete_id uuid;
alter table sports_data_access_grants add column if not exists grantee_id uuid;
alter table sports_data_access_grants add column if not exists scope text;
alter table sports_data_access_grants add column if not exists granted_at timestamptz default now();
alter table sports_data_access_grants add column if not exists revoked_at timestamptz default now();

create table if not exists sports_assessments (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid,
  coach_id uuid,
  date date,
  scores_json jsonb,
  notes text
);
alter table sports_assessments add column if not exists athlete_id uuid;
alter table sports_assessments add column if not exists coach_id uuid;
alter table sports_assessments add column if not exists date date;
alter table sports_assessments add column if not exists scores_json jsonb;
alter table sports_assessments add column if not exists notes text;

create table if not exists sports_training_plans (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid,
  coach_id uuid,
  plan_json jsonb,
  created_at timestamptz default now()
);
alter table sports_training_plans add column if not exists athlete_id uuid;
alter table sports_training_plans add column if not exists coach_id uuid;
alter table sports_training_plans add column if not exists plan_json jsonb;
alter table sports_training_plans add column if not exists created_at timestamptz default now();

create table if not exists sports_media (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid,
  type text,
  url text,
  created_at timestamptz default now()
);
alter table sports_media add column if not exists athlete_id uuid;
alter table sports_media add column if not exists type text;
alter table sports_media add column if not exists url text;
alter table sports_media add column if not exists created_at timestamptz default now();

create table if not exists sports_scout_reports (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid,
  athlete_id uuid,
  type text,
  body_json jsonb,
  created_at timestamptz default now()
);
alter table sports_scout_reports add column if not exists scout_id uuid;
alter table sports_scout_reports add column if not exists athlete_id uuid;
alter table sports_scout_reports add column if not exists type text;
alter table sports_scout_reports add column if not exists body_json jsonb;
alter table sports_scout_reports add column if not exists created_at timestamptz default now();

create table if not exists sports_funnel (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid,
  athlete_id uuid,
  stage text,
  parent_consent_at timestamptz default now(),
  trial_id uuid,
  offer_id uuid,
  notes text,
  history jsonb,
  updated_at timestamptz default now()
);
alter table sports_funnel add column if not exists scout_id uuid;
alter table sports_funnel add column if not exists athlete_id uuid;
alter table sports_funnel add column if not exists stage text;
alter table sports_funnel add column if not exists parent_consent_at timestamptz default now();
alter table sports_funnel add column if not exists trial_id uuid;
alter table sports_funnel add column if not exists offer_id uuid;
alter table sports_funnel add column if not exists notes text;
alter table sports_funnel add column if not exists history jsonb;
alter table sports_funnel add column if not exists updated_at timestamptz default now();

create table if not exists sports_saved_searches (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid,
  name text,
  filters_json jsonb,
  created_at timestamptz default now()
);
alter table sports_saved_searches add column if not exists scout_id uuid;
alter table sports_saved_searches add column if not exists name text;
alter table sports_saved_searches add column if not exists filters_json jsonb;
alter table sports_saved_searches add column if not exists created_at timestamptz default now();

create table if not exists sports_search_alerts (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid,
  athlete_id uuid,
  reason text,
  created_at timestamptz default now()
);
alter table sports_search_alerts add column if not exists scout_id uuid;
alter table sports_search_alerts add column if not exists athlete_id uuid;
alter table sports_search_alerts add column if not exists reason text;
alter table sports_search_alerts add column if not exists created_at timestamptz default now();

create table if not exists sports_scholarships (
  id uuid primary key default gen_random_uuid(),
  source text,
  type text,
  sport text,
  eligibility_json jsonb,
  deadline date,
  created_at timestamptz default now()
);
alter table sports_scholarships add column if not exists source text;
alter table sports_scholarships add column if not exists type text;
alter table sports_scholarships add column if not exists sport text;
alter table sports_scholarships add column if not exists eligibility_json jsonb;
alter table sports_scholarships add column if not exists deadline date;
alter table sports_scholarships add column if not exists created_at timestamptz default now();

create table if not exists sports_opportunities (
  id uuid primary key default gen_random_uuid(),
  type text,
  sport text,
  status text,
  host_id uuid,
  details_json jsonb,
  created_at timestamptz default now()
);
alter table sports_opportunities add column if not exists type text;
alter table sports_opportunities add column if not exists sport text;
alter table sports_opportunities add column if not exists status text;
alter table sports_opportunities add column if not exists host_id uuid;
alter table sports_opportunities add column if not exists details_json jsonb;
alter table sports_opportunities add column if not exists created_at timestamptz default now();

create table if not exists sports_opportunity_matches (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid,
  athlete_id uuid,
  match_score numeric,
  consented boolean,
  status text,
  created_at timestamptz default now()
);
alter table sports_opportunity_matches add column if not exists opportunity_id uuid;
alter table sports_opportunity_matches add column if not exists athlete_id uuid;
alter table sports_opportunity_matches add column if not exists match_score numeric;
alter table sports_opportunity_matches add column if not exists consented boolean;
alter table sports_opportunity_matches add column if not exists status text;
alter table sports_opportunity_matches add column if not exists created_at timestamptz default now();

create table if not exists sports_graph_nodes (
  id uuid primary key default gen_random_uuid(),
  type text,
  label text,
  data_json jsonb
);
alter table sports_graph_nodes add column if not exists type text;
alter table sports_graph_nodes add column if not exists label text;
alter table sports_graph_nodes add column if not exists data_json jsonb;

create table if not exists sports_graph_edges (
  id uuid primary key default gen_random_uuid(),
  from_id uuid,
  to_id uuid,
  type text,
  weight numeric
);
alter table sports_graph_edges add column if not exists from_id uuid;
alter table sports_graph_edges add column if not exists to_id uuid;
alter table sports_graph_edges add column if not exists type text;
alter table sports_graph_edges add column if not exists weight numeric;

create table if not exists sports_watchlists (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid,
  name text,
  athlete_ids uuid[],
  created_at timestamptz default now()
);
alter table sports_watchlists add column if not exists scout_id uuid;
alter table sports_watchlists add column if not exists name text;
alter table sports_watchlists add column if not exists athlete_ids uuid[];
alter table sports_watchlists add column if not exists created_at timestamptz default now();

create table if not exists sports_watchlist_items (
  id uuid primary key default gen_random_uuid(),
  watchlist_id uuid,
  athlete_id uuid,
  added_at timestamptz default now(),
  note text
);
alter table sports_watchlist_items add column if not exists watchlist_id uuid;
alter table sports_watchlist_items add column if not exists athlete_id uuid;
alter table sports_watchlist_items add column if not exists added_at timestamptz default now();
alter table sports_watchlist_items add column if not exists note text;

create table if not exists sports_vision_jobs (
  id uuid primary key default gen_random_uuid(),
  match_id uuid,
  athlete_id uuid,
  video_url text,
  status text,
  version text,
  created_at timestamptz default now()
);
alter table sports_vision_jobs add column if not exists match_id uuid;
alter table sports_vision_jobs add column if not exists athlete_id uuid;
alter table sports_vision_jobs add column if not exists video_url text;
alter table sports_vision_jobs add column if not exists status text;
alter table sports_vision_jobs add column if not exists version text;
alter table sports_vision_jobs add column if not exists created_at timestamptz default now();

create table if not exists sports_vision_outputs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid,
  type text,
  data_json jsonb,
  confidence text,
  created_at timestamptz default now()
);
alter table sports_vision_outputs add column if not exists job_id uuid;
alter table sports_vision_outputs add column if not exists type text;
alter table sports_vision_outputs add column if not exists data_json jsonb;
alter table sports_vision_outputs add column if not exists confidence text;
alter table sports_vision_outputs add column if not exists created_at timestamptz default now();

create table if not exists sports_talent_index (
  athlete_id uuid primary key,
  skill numeric,
  potential numeric,
  consistency numeric,
  pressure numeric,
  fitness numeric,
  coach numeric,
  composite numeric,
  computed_at timestamptz default now()
);
alter table sports_talent_index add column if not exists skill numeric;
alter table sports_talent_index add column if not exists potential numeric;
alter table sports_talent_index add column if not exists consistency numeric;
alter table sports_talent_index add column if not exists pressure numeric;
alter table sports_talent_index add column if not exists fitness numeric;
alter table sports_talent_index add column if not exists coach numeric;
alter table sports_talent_index add column if not exists composite numeric;
alter table sports_talent_index add column if not exists computed_at timestamptz default now();

create table if not exists sports_fitness_tests (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid,
  type text,
  value numeric,
  date date
);
alter table sports_fitness_tests add column if not exists athlete_id uuid;
alter table sports_fitness_tests add column if not exists type text;
alter table sports_fitness_tests add column if not exists value numeric;
alter table sports_fitness_tests add column if not exists date date;

create table if not exists sports_agent_suggestions (
  id uuid primary key default gen_random_uuid(),
  agent text,
  subject_type text,
  subject_id uuid,
  payload_json jsonb,
  high_stakes boolean,
  status text,
  created_at timestamptz default now()
);
alter table sports_agent_suggestions add column if not exists agent text;
alter table sports_agent_suggestions add column if not exists subject_type text;
alter table sports_agent_suggestions add column if not exists subject_id uuid;
alter table sports_agent_suggestions add column if not exists payload_json jsonb;
alter table sports_agent_suggestions add column if not exists high_stakes boolean;
alter table sports_agent_suggestions add column if not exists status text;
alter table sports_agent_suggestions add column if not exists created_at timestamptz default now();

create table if not exists sports_revenue_events (
  id uuid primary key default gen_random_uuid(),
  source text,
  athlete_id uuid,
  gross text,
  splits_json jsonb,
  mode text,
  created_at timestamptz default now()
);
alter table sports_revenue_events add column if not exists source text;
alter table sports_revenue_events add column if not exists athlete_id uuid;
alter table sports_revenue_events add column if not exists gross text;
alter table sports_revenue_events add column if not exists splits_json jsonb;
alter table sports_revenue_events add column if not exists mode text;
alter table sports_revenue_events add column if not exists created_at timestamptz default now();
