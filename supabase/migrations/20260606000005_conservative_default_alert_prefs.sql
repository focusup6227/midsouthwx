-- Tighter default for new subscribers: warnings only. Watches/advisories
-- generate a lot of buzz that overwhelms casual subscribers; the Telegram
-- onboarding flow nudges them to opt into watches if they want a heads-up
-- before warnings arrive.
--
-- Existing rows are left alone — only the column default changes, so users
-- who deliberately opted into watches/advisories don't lose that setting.

alter table public.subscribers
  alter column alert_preferences set default '{
    "warnings": true,
    "watches": false,
    "advisories": false,
    "statements": false,
    "skip_hazards": []
  }'::jsonb;
