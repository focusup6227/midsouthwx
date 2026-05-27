-- Operator enrollment must happen through trusted server code, not by any
-- authenticated user inserting their own public.operators row.

drop policy if exists "operator inserts self" on public.operators;
