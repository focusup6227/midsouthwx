-- Publish cap_alerts on supabase_realtime so the /nws + /radar dashboards
-- can live-refresh as LibreWxR ingests new CAP alerts, matching the
-- existing nws_alerts publication. Idempotent: pg_publication_tables is
-- consulted so re-running the migration is a no-op.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'cap_alerts'
  ) then
    execute 'alter publication supabase_realtime add table public.cap_alerts';
  end if;
end$$;
