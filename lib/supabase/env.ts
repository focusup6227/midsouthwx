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
