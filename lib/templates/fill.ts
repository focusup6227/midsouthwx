export type TemplateContext = {
  headline?: string;
  event?: string;
  expiresAt?: string;
  areaDesc?: string;
};

export function fillTemplate(body: string, ctx: TemplateContext): string {
  return body
    .replace(/\{\{headline\}\}/g, ctx.headline ?? '')
    .replace(/\{\{event\}\}/g, ctx.event ?? '')
    .replace(/\{\{expires_at\}\}/g, ctx.expiresAt ?? '')
    .replace(/\{\{area_desc\}\}/g, ctx.areaDesc ?? '');
}

// {{url}} is auto-filled server-side after the message row is inserted
// (compose path → /m/<id>; nws-dispatcher → /alert/<nws_id>), so it doesn't
// need operator input and shouldn't trigger the Template Variables UI when
// it's the only placeholder in the body.
const AUTO_FILLED_VARS = new Set(['url']);

export function templateHasVariables(body: string): boolean {
  const matches = body.match(/\{\{([\w_]+)\}\}/g) ?? [];
  return matches.some((m) => !AUTO_FILLED_VARS.has(m.slice(2, -2)));
}

export const TEMPLATE_VARIABLES = [
  { key: 'headline', label: 'Headline', placeholder: 'NWS headline or summary' },
  { key: 'event', label: 'Event', placeholder: 'Tornado Warning' },
  { key: 'area_desc', label: 'Area', placeholder: 'Shelby, TN; DeSoto, MS' },
  { key: 'expires_at', label: 'Expires', placeholder: '5/20/2026, 3:45 PM CDT' },
] as const;
