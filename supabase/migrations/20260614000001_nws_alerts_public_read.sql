-- Public-read access for /alert/[nws_id]: the link in outbound Telegram
-- messages must resolve for un-authenticated subscribers. Restricted to
-- non-expired alerts (and a 24-hour post-expiry grace window) so the policy
-- doesn't double as an open archive.

create policy "public nws_alerts_select_active"
  on public.nws_alerts for select
  to anon, authenticated
  using (
    expires_at is null
    or expires_at > now() - interval '24 hours'
  );

grant select on public.nws_alerts to anon;
