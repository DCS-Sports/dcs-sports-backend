-- Smart-camera / DRS tracked events. Every row is an ESTIMATE with a confidence —
-- never presented as ground truth. Feeds the officials' event-center and the fan broadcast.
create table if not exists sports_tracked_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid,
  type text,                 -- boundary | four | six | catch | wicket | ...
  over integer,
  ball integer,
  athlete_id uuid,
  confidence numeric,        -- 0..1 model confidence
  estimate boolean default true,
  data_json jsonb,
  created_at timestamptz default now()
);
create index if not exists sports_tracked_events_match on sports_tracked_events (match_id);
