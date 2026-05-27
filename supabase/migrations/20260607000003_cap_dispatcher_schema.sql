-- Stage 2 prep: schema additions for the parallel cap-dispatcher.
--
-- We keep nws-dispatcher (and its tables/RPCs) 100% untouched and run
-- cap-dispatcher alongside it. The two dispatchers are independent — each
-- has its own claim/finish RPCs and its own cron schedule. cap-dispatcher
-- stays inert until the operator sets CAP_DISPATCHER_ENABLED=1 in Edge
-- Function secrets, so dispatch behavior cannot regress on deploy.

-- 1. Add 'cap' to message_source so dispatcher-inserted CAP rows are
-- distinguishable from nws/manual/scheduled. Safe inside the same migration
-- because no statement in this file uses the new value (only Edge Function
-- code does, after this commits).
alter type public.message_source add value if not exists 'cap';

-- 2. Per-alert tornado-notify idempotency, same pattern as nws_alerts.
alter table public.cap_alerts
  add column if not exists operator_alerted_at timestamptz;

-- 3. Link from message → originating CAP alert (parallel to messages.nws_alert_id).
alter table public.messages
  add column if not exists cap_alert_id uuid references public.cap_alerts(id) on delete set null;

create index if not exists messages_cap_alert_idx
  on public.messages (cap_alert_id)
  where cap_alert_id is not null;
