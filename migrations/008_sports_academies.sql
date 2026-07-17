-- Academies (Academy OS). Owner is the creating user; players link in via sports_academy_players.
create table if not exists sports_academies (
  id uuid primary key default gen_random_uuid(),
  name text,
  owner_user_id uuid,
  city text,
  state text,
  verified_status text default 'unverified',
  created_at timestamptz default now()
);
create index if not exists sports_academies_owner on sports_academies (owner_user_id);
