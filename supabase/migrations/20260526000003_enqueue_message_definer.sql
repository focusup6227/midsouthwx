-- public.enqueue_message was created as SECURITY INVOKER. The function itself
-- gatekeeps with `if not public.is_operator() then raise exception`, but the
-- INSERT into public.outbound_queue then runs as the operator role — which
-- has no INSERT policy on that table (only SELECT for operators). Result:
-- every operator-initiated send via /compose blows up with
-- "new row violates row-level security policy for table outbound_queue".
--
-- Fix: make it SECURITY DEFINER like its sibling `enqueue_message_system`.
-- The is_operator() check inside the body still enforces operator-only
-- access, so this doesn't widen authorization.

create or replace function public.enqueue_message(p_message_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_spec jsonb;
  v_count int;
begin
  if not public.is_operator() then
    raise exception 'not authorized';
  end if;

  select audience_spec into v_spec from public.messages where id = p_message_id;
  if v_spec is null then
    raise exception 'message not found';
  end if;

  insert into public.outbound_queue (message_id, subscriber_id)
  select p_message_id, ra.subscriber_id
  from public.resolve_audience(v_spec) ra
  on conflict (message_id, subscriber_id) do nothing;

  select count(*)::int into v_count
  from public.outbound_queue
  where message_id = p_message_id;

  update public.messages
  set status = 'queued',
      recipient_count = v_count
  where id = p_message_id;

  return v_count;
end$$;

-- Re-assert grants — CREATE OR REPLACE leaves existing grants intact, but
-- this makes the contract explicit for fresh deployments.
revoke all on function public.enqueue_message(uuid) from public, anon;
grant execute on function public.enqueue_message(uuid) to authenticated, service_role;
