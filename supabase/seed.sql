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
  ),
  (
    'Winter Storm Warning',
    'winter',
    'WINTER STORM WARNING for your area.\n\nHeavy snow or ice is expected. Limit travel and prepare for possible power outages.',
    '[{"label":"✅ Got it","data":"ack"},{"label":"⚠️ Need help","data":"help"}]'::jsonb
  )
on conflict (name) do nothing;

-- Default NWS auto-alert rules (v3). Requires migrations through nws_alerts.

insert into public.auto_alert_rules (event_pattern, min_severity, mode, region_filter, template_id, enabled)
select 'Special Weather Statement', null, 'ignore'::public.rule_mode, null, null, true
where not exists (select 1 from public.auto_alert_rules r where r.event_pattern = 'Special Weather Statement');

insert into public.auto_alert_rules (event_pattern, min_severity, mode, region_filter, template_id, enabled)
select 'Tornado Warning', null, 'review'::public.rule_mode, null, t.id, true
from public.templates t where t.name = 'Tornado Warning'
and not exists (select 1 from public.auto_alert_rules r where r.event_pattern = 'Tornado Warning');

insert into public.auto_alert_rules (event_pattern, min_severity, mode, region_filter, template_id, enabled)
select 'Severe Thunderstorm Warning', null, 'review'::public.rule_mode, null, t.id, true
from public.templates t where t.name = 'Severe Thunderstorm Warning'
and not exists (select 1 from public.auto_alert_rules r where r.event_pattern = 'Severe Thunderstorm Warning');

insert into public.auto_alert_rules (event_pattern, min_severity, mode, region_filter, template_id, enabled)
select 'Flash Flood Warning', null, 'review'::public.rule_mode, null, t.id, true
from public.templates t where t.name = 'Flash Flood Warning'
and not exists (select 1 from public.auto_alert_rules r where r.event_pattern = 'Flash Flood Warning');

insert into public.auto_alert_rules (event_pattern, min_severity, mode, region_filter, template_id, enabled)
select 'Winter Storm Warning', null, 'review'::public.rule_mode, null, t.id, true
from public.templates t where t.name = 'Winter Storm Warning'
and not exists (select 1 from public.auto_alert_rules r where r.event_pattern = 'Winter Storm Warning');

