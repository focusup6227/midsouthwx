-- pg_stat_statements showed the hottest NWS paths are radar refreshes and
-- repeated status/count/list lookups. These indexes support the actual WHERE
-- clauses instead of scanning event text or stale/null-expiration rows.

create index if not exists nws_alerts_status_expires_ingested_idx
  on public.nws_alerts (status, expires_at, ingested_at desc);

create index if not exists nws_alerts_ingested_desc_idx
  on public.nws_alerts (ingested_at desc);

create index if not exists nws_alerts_ai_summary_work_idx
  on public.nws_alerts (expires_at, ingested_at desc)
  where ai_summary is null;

create index if not exists nws_alerts_null_expires_ingested_idx
  on public.nws_alerts (ingested_at)
  where expires_at is null;

create index if not exists cap_alerts_null_expires_ingested_idx
  on public.cap_alerts (ingested_at)
  where expires_at is null;
