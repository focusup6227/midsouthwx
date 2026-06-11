-- Cutover: stop pg_cron from invoking the Edge Functions that the worker
-- process now runs. Run this MANUALLY (SQL editor or psql) AFTER the worker
-- is deployed and /healthz shows jobs running — this is deliberately not a
-- migration so an unrelated `npm run db:push` can never switch delivery off.
--
-- Pure-SQL maintenance jobs (prunes/sweeps: signup-attempts-prune,
-- radar-tiles-sweep, retention-prune-2yr, nws-alerts-prune, nws-afd-prune,
-- function-runs-prune, subscriber-states-prune,
-- subscriber-temp-location-expire, fill-default-expires, forecast-verify,
-- alert-snapshots-sweep, radar-couplets-prune, couplet-alerts-prune,
-- forecast-template-tick) stay on pg_cron — SQL on a timer is what pg_cron
-- is for.
--
-- Rollback: worker/rollback.sql restores all 14 schedules.

select cron.unschedule(jobname)
from cron.job
where jobname in (
  'send-worker',
  'scheduled-dispatcher',
  'nws-poll',
  'nws-dispatcher',
  'lsr-poll',
  'spc-poll',
  'nws-afd-poll',
  'librewxr-poll',
  'cap-dispatcher',
  'health-monitor',
  'event-recap',
  'couplet-poll',
  'couplet-dispatcher',
  'daily-forecast'
);

-- Verify: should return only the pure-SQL maintenance jobs.
select jobname, schedule from cron.job order by jobname;
