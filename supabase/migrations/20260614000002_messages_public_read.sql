-- Public-read access for /m/[id]: operator-composed alerts can include a
-- {{url}} placeholder that resolves to this page; subscribers need to open
-- the URL without an operator login. Restricted to recently-sent messages
-- (sent/sending status, within 7 days) so the policy doesn't double as an
-- open archive of every operator message ever sent.

create policy "public messages_select_recent_sent"
  on public.messages for select
  to anon, authenticated
  using (
    status in ('sent', 'sending')
    and created_at > now() - interval '7 days'
  );

grant select on public.messages to anon;
