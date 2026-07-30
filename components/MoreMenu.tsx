'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isActivePath } from './NavLinks';
import type { NavItem } from './nav-data';

/**
 * Desktop "More" dropdown for secondary nav. Replaces the old <details>
 * element: closes on Escape, outside click, and route change; highlights
 * the active section.
 */
export default function MoreMenu({ links }: { links: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname() ?? '';

  // Close when navigating.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const sectionActive = links.some((l) => isActivePath(pathname, l.href));

  return (
    <div ref={ref} className="relative hidden md:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`rounded px-2.5 py-1 text-sm ${
          sectionActive ? 'bg-wx-accent/10 font-semibold text-wx-accent' : 'text-wx-mute hover:text-wx-fg'
        }`}
      >
        More ▾
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-44 rounded-lg border border-wx-line bg-wx-card py-1 shadow-lg"
        >
          {links.map((l) => {
            const active = isActivePath(pathname, l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                role="menuitem"
                aria-current={active ? 'page' : undefined}
                className={`block px-3 py-1.5 text-sm hover:bg-wx-ink ${
                  active ? 'font-semibold text-wx-accent' : 'text-wx-fg'
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
