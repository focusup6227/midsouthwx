-- AI-generated 2-sentence summary for AFDs. Populated by afd-poll's
-- summarizer right after the per-WFO upsert; rendered in the radar inspector
-- so the operator gets the headline without reading the whole 800-word
-- discussion.

alter table public.nws_afd
  add column if not exists ai_summary text;
