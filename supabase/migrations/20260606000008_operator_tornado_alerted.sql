-- One-shot operator notification gate for Tornado Warnings / Emergencies.
-- The dispatcher atomically claims the right to send by setting this column
-- with `RETURNING` — if another worker raced and got there first, the query
-- returns zero rows and we silently skip.

alter table public.nws_alerts
  add column if not exists operator_alerted_at timestamptz;

create index if not exists nws_alerts_op_alerted_pending_idx
  on public.nws_alerts (event)
  where operator_alerted_at is null;
