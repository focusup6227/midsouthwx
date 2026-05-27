/**
 * Dashboard may show a publishable key (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`);
 * older docs use the JWT anon key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`). Either works
 * with createBrowserClient / createServerClient.
 */
export function supabasePublishableKey(): string {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ''
  );
}

export function mapboxAccessToken(): string {
  return process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';
}

/**
 * Custom Mapbox style URL. If `NEXT_PUBLIC_MAPBOX_STYLE` is set in
 * .env.local (e.g. the forked dark-v11 produced by
 * scripts/clone-mapbox-style.mjs), the radar uses it instead of
 * `mapbox://styles/mapbox/dark-v11`. Falls back when unset.
 */
export function mapboxStyleUrl(): string {
  return process.env.NEXT_PUBLIC_MAPBOX_STYLE || 'mapbox://styles/mapbox/dark-v11';
}
