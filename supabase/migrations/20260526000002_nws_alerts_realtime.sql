-- Stream nws_alerts INSERT/UPDATE/DELETE through Supabase Realtime so the
-- /nws dashboard can refresh live as the poll/dispatcher cycle runs.
-- `messages` is already in the publication via 20260518000005_inbox.sql.

alter publication supabase_realtime add table public.nws_alerts;
