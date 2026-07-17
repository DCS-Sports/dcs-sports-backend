-- ROLLBACK: instantly disable RLS if the dashboard breaks after applying 010b.
-- Run any/all of these; effect is immediate (service-role backend is unaffected either way).

alter table sports_data_access_grants disable row level security;
alter table sports_match_performances disable row level security;
alter table sports_verifications disable row level security;
