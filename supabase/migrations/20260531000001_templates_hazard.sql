-- F1 (warning-row one-tap send): tag templates with the hazard they're
-- written for so /compose can auto-select the right one when the operator
-- launches a send from a tornado / severe / flood etc. warning.
--
-- Nullable so existing templates stay valid (generic templates have hazard
-- = null and never auto-match). Check constraint mirrors NwsHazardKind in
-- lib/nws/radar.ts — keep these in sync if you add a new hazard kind.

alter table public.templates
  add column if not exists hazard text;

alter table public.templates
  drop constraint if exists templates_hazard_check;
alter table public.templates
  add constraint templates_hazard_check
  check (hazard is null or hazard in (
    'tornado', 'severe', 'flood', 'winter', 'heat', 'wind'
  ));

-- Partial index — only useful when looking up by hazard, which only happens
-- when a non-null hazard query param is in play.
create index if not exists templates_hazard_idx
  on public.templates (hazard)
  where hazard is not null;

comment on column public.templates.hazard is
  'Optional hazard tag (tornado|severe|flood|winter|heat|wind). When /compose '
  'receives ?hazard=X, it auto-selects the first template where hazard=X. '
  'Null = generic template, never auto-matched.';
