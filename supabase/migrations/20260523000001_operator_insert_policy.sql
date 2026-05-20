-- Allow authenticated users to insert their own operators row (invite / magic-link enrollment).

create policy "operator inserts self"
  on public.operators for insert
  with check (user_id = auth.uid());
