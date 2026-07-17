-- Marketing lead capture + funnel events (public site). 17 Jul 2026.
create table if not exists sports_leads (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('academy','league','football_pilot','scout','tennis_research','other')),
  name text not null, contact text not null,
  city text, athletes text, coaches text, teams text, matches_per_month text,
  scoring_process text, camera_interest boolean default false,
  preferred_time text, dates text, note text,
  utm_source text, utm_medium text, utm_campaign text, utm_content text,
  status text not null default 'new',
  created_at timestamptz not null default now()
);
create index if not exists idx_sports_leads_kind on sports_leads(kind, status);
create table if not exists sports_web_events (
  id bigint generated always as identity primary key,
  name text not null, page text,
  utm_source text, utm_medium text, utm_campaign text, utm_content text, ref text,
  created_at timestamptz not null default now()
);
create index if not exists idx_sports_web_events_name on sports_web_events(name, created_at);
alter table sports_leads enable row level security;
alter table sports_web_events enable row level security;
-- service-role only (no public read); inserts happen via the API's service client.
