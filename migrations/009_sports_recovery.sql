-- Recovery OS — injury tracking, workload and readiness (wellbeing-first).
create table if not exists sports_recovery (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid,
  type text,            -- injury | recovery | workload | note
  status text,          -- e.g. active | recovering | cleared
  note text,
  workload numeric,     -- session load
  readiness numeric,    -- 0..100 readiness estimate
  created_at timestamptz default now()
);
create index if not exists sports_recovery_athlete on sports_recovery (athlete_id);
