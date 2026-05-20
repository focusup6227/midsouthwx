/** ICS snippet for weekly recurrence anchored at dt (UTC). Matches scheduled-dispatcher rrulestr(). */
export function buildWeeklyRruleIc(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = dt.getUTCFullYear();
  const m = pad(dt.getUTCMonth() + 1);
  const d = pad(dt.getUTCDate());
  const hh = pad(dt.getUTCHours());
  const mm = pad(dt.getUTCMinutes());
  const ss = pad(dt.getUTCSeconds());
  return `DTSTART:${y}${m}${d}T${hh}${mm}${ss}Z\nRRULE:FREQ=WEEKLY;INTERVAL=1`;
}
