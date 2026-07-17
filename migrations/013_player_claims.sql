-- Player-claim capture: the acquisition funnel. A viewer sees a name on the public
-- scorecard and claims it ("this is me") — we capture the lead + attach match stats later.
-- Public insert (from the fan page), org-only read (RLS added surgically later if needed).
create table if not exists sports_player_claims (
  id uuid primary key default gen_random_uuid(),
  match_id uuid,
  player_name text,
  email text,
  contact text,
  note text,
  status text default 'new',   -- new | contacted | claimed | rejected
  created_at timestamptz default now()
);
create index if not exists sports_player_claims_match on sports_player_claims (match_id);
create index if not exists sports_player_claims_status on sports_player_claims (status);
