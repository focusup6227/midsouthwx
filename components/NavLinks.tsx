'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export type NavLinkItem = { href: string; label: string };

// Section-aware active matcher. Nav hrefs sometimes point at a sub-page
// (Forecast → /forecast/workflow), so a link is "active" when the current
// path lives anywhere under the link's top-level segment — /forecast/skill
// still lights up Forecast.
export function isActivePath(pathname: string, href: string): boolean {
  const section = '/' + (href.split('/')[1] ?? '');
  return pathname === href || pathname === section || pathname.startsWith(`${section}/`);
}

/** Desktop primary nav row with current-section highlighting. */
export default function NavLinks({ links }: { links: NavLinkItem[] }) {
  const pathname = usePathname() ?? '';
  return (
    <div className="hidden flex-wrap items-center gap-1 md:flex">
      {links.map((l) => {
        const active = isActivePath(pathname, l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded px-2.5 py-1 text-sm ${
              active
                ? 'bg-wx-accent/10 font-semibold text-wx-accent'
                : 'text-wx-mute hover:text-wx-fg'
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </div>
  );
}
