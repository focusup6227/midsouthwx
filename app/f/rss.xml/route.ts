import { supabaseAdmin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// RSS 2.0 feed of shared forecasts — same row filter as the /f index (token
// set + issued/closed). Gives the YouTube description and any feed reader a
// stable subscription target.

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type Row = {
  title: string;
  hazards: string[] | null;
  status: string;
  valid_from: string;
  valid_until: string;
  discussion: string | null;
  public_token: string;
  created_at: string;
};

export async function GET(req: Request) {
  // Prefer the configured production origin; fall back to the request origin
  // so dev/preview still emit absolute (valid-RSS) links.
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin).replace(/\/$/, '');

  const admin = supabaseAdmin();
  const { data } = await admin
    .from('forecasts')
    .select('title, hazards, status, valid_from, valid_until, discussion, public_token, created_at')
    .not('public_token', 'is', null)
    .in('status', ['issued', 'closed'])
    .order('created_at', { ascending: false })
    .limit(30);
  const rows = (data ?? []) as Row[];

  const items = rows
    .map((f) => {
      const link = `${base}/f/${f.public_token}`;
      const hazards = (f.hazards ?? []).join(', ');
      const excerpt = (f.discussion ?? '').slice(0, 400);
      const description = [hazards ? `Hazards: ${hazards}.` : null, excerpt].filter(Boolean).join(' ');
      return [
        '<item>',
        `<title>${esc(f.title)}</title>`,
        `<link>${esc(link)}</link>`,
        `<guid isPermaLink="true">${esc(link)}</guid>`,
        `<pubDate>${new Date(f.created_at).toUTCString()}</pubDate>`,
        `<description>${esc(description || 'Mid-South WX operator forecast.')}</description>`,
        '</item>',
      ].join('');
    })
    .join('\n');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0"><channel>` +
    `<title>Mid-South WX Forecasts</title>` +
    `<link>${esc(`${base}/f`)}</link>` +
    `<description>Operator-issued severe-weather outlooks for the Mid-South.</description>` +
    `<language>en-us</language>\n` +
    items +
    `\n</channel></rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      // Modest edge cache: forecasts publish a few times a week at most.
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    },
  });
}
