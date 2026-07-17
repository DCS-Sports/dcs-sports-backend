-- Match rosters with real names (so scorecards show names, not uuids).
-- The rich ball model (striker/bowler/extras/wicket) rides in sports_live_scores.event_json (jsonb),
-- so no schema change needed there.
create table if not exists sports_match_players (
  id uuid primary key default gen_random_uuid(),
  match_id uuid,
  team text,            -- 'home' | 'away'
  name text,
  batting_order integer,
  athlete_id uuid,      -- optional link to a real athlete passport
  created_at timestamptz default now()
);
create index if not exists sports_match_players_match on sports_match_players (match_id);
