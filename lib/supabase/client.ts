'use client';
import { createBrowserClient } from '@supabase/ssr';

import { supabasePublishableKey } from './env';

export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    supabasePublishableKey(),
  );
}
