-- Surgical RLS — closes the one real gap: minor-gating for Scout, + self-read.
-- Only the two tables the BROWSER reads directly are gated. Everything else goes
-- through the service-role backend, which bypasses RLS entirely (unaffected).
-- Idempotent. Instant rollback: 011_ROLLBACK_disable_rls.sql.

-- helper: does the current user hold an active access grant on this athlete?
-- security definer → reads the grants table without RLS recursion into sports_athletes.
create or replace function sports_has_grant(a_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from sports_data_access_grants g
    where g.athlete_id = a_id
      and g.grantee_id = auth.uid()
      and g.revoked_at is null
      and (g.granted_at is not null)
  );
$$;

-- ── sports_users: a signed-in user sees/edits only their own row ──
-- (this is what the dashboard reads for role_flags → keep it working)
alter table sports_users enable row level security;
drop policy if exists sports_users_self_read   on sports_users;
create policy sports_users_self_read   on sports_users for select using (id = auth.uid());
drop policy if exists sports_users_self_update on sports_users;
create policy sports_users_self_update on sports_users for update using (id = auth.uid());

-- ── sports_athletes: read gating (the real fix — Scout uses the user-scoped client) ──
--   • owner always sees their own row
--   • an explicit access grant lets a grantee (scout) read
--   • discoverable/public ADULTS are visible to any signed-in user
--   • MINORS are never surfaced by discoverability — only owner or a grant
alter table sports_athletes enable row level security;
drop policy if exists sports_athletes_read on sports_athletes;
create policy sports_athletes_read on sports_athletes for select using (
  user_id = auth.uid()
  or sports_has_grant(id)
  or (
    visibility in ('discoverable','public')
    and (dob is null or dob <= (current_date - interval '18 years'))  -- adult only
    and auth.role() = 'authenticated'
  )
);

-- writes: owner may insert/update their own row (backend uses service role either way)
drop policy if exists sports_athletes_self_update on sports_athletes;
create policy sports_athletes_self_update on sports_athletes for update using (user_id = auth.uid());
drop policy if exists sports_athletes_self_insert on sports_athletes;
create policy sports_athletes_self_insert on sports_athletes for insert with check (user_id = auth.uid());
