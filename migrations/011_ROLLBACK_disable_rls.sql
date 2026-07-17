-- ROLLBACK for 011_surgical_rls.sql — instant, safe. Run if the dashboard breaks.
-- The service-role backend is unaffected either way.
alter table sports_athletes disable row level security;
alter table sports_users    disable row level security;
