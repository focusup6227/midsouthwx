// Pure helpers shared by the triage server actions and the promote-page UI.
// Kept in a non-'use server' module because Next forbids sync exports from
// server-action files.

const HAZARD_HEADLINE: Record<string, string> = {
  tornado: 'TORNADO',
  funnel: 'FUNNEL CLOUD',
  wind: 'DAMAGING WIND',
  hail: 'HAIL',
  flood: 'FLOODING',
  other: 'SEVERE WEATHER',
};

/** Build the default broadcast text for a promote-to-broadcast action.
 *  Operator can edit before sending. */
export function defaultPromotionBody(report: {
  hazard: string;
  place_name: string | null;
  lat: number;
  lon: number;
  description: string | null;
}): string {
  const head = HAZARD_HEADLINE[report.hazard] ?? 'SEVERE WEATHER';
  const loc = report.place_name ?? `${report.lat.toFixed(3)}, ${report.lon.toFixed(3)}`;
  const note = report.description ? `\n\n"${report.description.slice(0, 200)}"` : '';
  return (
    `🚨 SPOTTER-CONFIRMED ${head} near ${loc}.\n\n` +
    `Take shelter immediately if you are in the area. ` +
    `Move to an interior room on the lowest floor, away from windows.${note}`
  );
}
