-- RLS policies call is_operator() across most dashboard tables. Keep it
-- constant-time and avoid evaluating the operators table through RLS for every
-- protected row. The function only returns whether the current JWT subject has
-- an operator row; it does not expose row data.

create or replace function public.is_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and exists (
       select 1
       from public.operators
       where user_id = auth.uid()
     );
$$;

revoke all on function public.is_operator() from public;
grant execute on function public.is_operator() to authenticated, service_role;

notify pgrst, 'reload schema';
