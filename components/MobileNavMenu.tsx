'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import type { ReactNode } from 'react';

export type MobileMenuLink = { href: string; label: string; extra?: ReactNode };

/**
 * Inline header hamburger for standard (non-bare) pages. Replaces the old
 * horizontal-scroll chip row: a single button that opens a full nav drawer of
 * all tabs. Mobile only (md:hidden); desktop keeps the inline nav + More menu.
 */
export default function MobileNavMenu({ links }: { links: MobileMenuLink[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-wx-line bg-wx-ink text-wx-fg"
      >
        <Menu size={18} />
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="absolute inset-x-3 top-3 max-h-[85vh] overflow-y-auto rounded-xl border border-wx-line bg-wx-card p-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">Menu</span>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" className="text-wx-mute hover:text-wx-fg">
                <X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-1.5 rounded-md border border-wx-line px-3 py-2.5 text-sm text-wx-fg hover:bg-wx-ink"
                >
                  {l.label}
                  {l.extra}
                </Link>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
