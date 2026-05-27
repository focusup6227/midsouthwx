-- PostgREST builds its schema cache as the authenticator role. A short
-- statement_timeout on that role can make every REST request fail with
-- PGRST002 once the exposed schema grows enough for cache introspection to
-- exceed the timeout. Keep end-user role timeouts separate; this only gives
-- PostgREST enough room to rebuild metadata.

alter role authenticator set statement_timeout = '60s';
alter role authenticator set lock_timeout = '30s';

notify pgrst, 'reload config';
notify pgrst, 'reload schema';
