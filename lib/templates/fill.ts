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

export function templateHasVariables(body: string): boolean {
  return /\{\{[\w_]+\}\}/.test(body);
}

export const TEMPLATE_VARIABLES = [
  { key: 'headline', label: 'Headline', placeholder: 'NWS headline or summary' },
  { key: 'event', label: 'Event', placeholder: 'Tornado Warning' },
  { key: 'area_desc', label: 'Area', placeholder: 'Shelby, TN; DeSoto, MS' },
  { key: 'expires_at', label: 'Expires', placeholder: '5/20/2026, 3:45 PM CDT' },
] as const;
