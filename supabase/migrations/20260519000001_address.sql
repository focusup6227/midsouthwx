-- 0009 — home + current address for trapped-subscriber lookup.
-- home_address: captured at signup, doesn't change.
-- current_address: set ad-hoc via /where <address> when subscriber isn't home.
-- current_address_updated_at: when the operator should consider current_address stale.

alter table public.subscribers
  add column if not exists home_address text,
  add column if not exists current_address text,
  add column if not exists current_address_updated_at timestamptz;
