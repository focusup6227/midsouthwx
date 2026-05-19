-- Seed: starter templates for v1. Operator row is inserted from the dashboard
-- on first sign-in (see app/login/page.tsx callback).

insert into public.templates (name, category, body_md, default_quick_replies) values
  (
    'Tornado Warning',
    'tornado',
    'TORNADO WARNING — take shelter NOW.\n\nMove to an interior room on the lowest floor. Stay away from windows. Cover your head.',
    '[{"label":"✅ Safe","data":"safe"},{"label":"⚠️ Need help","data":"help"},{"label":"🏠 Sheltering","data":"sheltering"}]'::jsonb
  ),
  (
    'Severe Thunderstorm Warning',
    'thunderstorm',
    'SEVERE THUNDERSTORM WARNING for your area.\n\nDamaging winds and large hail are possible. Stay indoors and away from windows.',
    '[{"label":"✅ Got it","data":"ack"},{"label":"⚠️ Damage here","data":"damage"}]'::jsonb
  ),
  (
    'Flash Flood Warning',
    'flood',
    'FLASH FLOOD WARNING.\n\nDo not drive through flooded roads. Move to higher ground if water is rising near you.',
    '[{"label":"✅ Safe","data":"safe"},{"label":"🚗 Road flooded","data":"road"},{"label":"⚠️ Need help","data":"help"}]'::jsonb
  ),
  (
    'Family Check-in',
    'checkin',
    'Family check-in. Tap a button when you can.',
    '[{"label":"✅ Safe","data":"safe"},{"label":"🏠 Sheltering","data":"sheltering"},{"label":"⚠️ Need help","data":"help"}]'::jsonb
  ),
  (
    'Test Alert',
    'test',
    'This is a TEST message from Mid-South WX. No action needed.',
    '[{"label":"👍 Received","data":"ack"}]'::jsonb
  )
on conflict (name) do nothing;

-- Default auto-alert rules (used once 0006 migration ships and rules table exists).
-- Intentionally not inserted here yet — see v3 milestone.
