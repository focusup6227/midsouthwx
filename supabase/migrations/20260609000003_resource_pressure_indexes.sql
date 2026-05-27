-- Target the high-frequency dashboard/list/export predicates so routine UI
-- refreshes do not fall back to broad table scans as data grows.

create index if not exists replies_unread_idx
  on public.replies (received_at desc)
  where read_at is null;

create index if not exists messages_status_source_created_idx
  on public.messages (status, source, created_at desc);

create index if not exists messages_created_desc_idx
  on public.messages (created_at desc);

create index if not exists delivery_logs_occurred_desc_idx
  on public.delivery_logs (occurred_at desc);

create index if not exists external_delivery_logs_message_occurred_idx
  on public.external_delivery_logs (message_id, occurred_at desc);

create index if not exists conversations_inbox_order_idx
  on public.conversations (pinned desc, last_message_at desc nulls last);

create index if not exists nws_alerts_status_ingested_idx
  on public.nws_alerts (status, ingested_at desc);
