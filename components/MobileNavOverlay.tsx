'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Menu, X } from 'lucide-react';
import FieldModeToggle from './FieldModeToggle';
import HealthIndicator from './HealthIndicator';

export type MobileNavLink = { href: string; label: string };

type Props = {
  primary: MobileNavLink[];
  secondary: MobileNavLink[];
  field: boolean;
};

/**
 * Floating hamburger for `bare` pages (radar/map) so the dashboard chrome
 * doesn't eat ~80px of vertical space at the top of the viewport on phones.
 * Renders only on mobile; desktop keeps the standard sticky header.
 */
export default function MobileNavOverlay({ primary, secondary, field }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="md:hidden fixed top-3 right-14 z-[60] inline-flex items-center justify-center w-9 h-9 rounded-lg bg-wx-card/95 border border-wx-line backdrop-blur-sm shadow-lg text-wx-fg"
        aria-label="Open menu"
        aria-expanded={open}
      >
        <Menu size={18} />
        {field ? (
          <span
            className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-wx-accent border border-wx-ink"
            aria-label="Field mode on"
          />
        ) : null}
      </button>

      {open ? (
        <div
          className="md:hidden fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="absolute top-3 left-3 right-3 max-h-[85vh] overflow-y-auto wx-scroll rounded-xl border border-wx-line bg-wx-card p-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-center justify-between gap-2 mb-3">
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 font-semibold"
                onClick={() => setOpen(false)}
              >
                <Image src="/icons/icon-192.png" alt="" width={24} height={24} className="rounded-full" />
                MidSouthWX
              </Link>
              <div className="flex items-center gap-2">
                <HealthIndicator />
                <FieldModeToggle active={field} />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close menu"
                  className="text-wx-mute hover:text-wx-fg"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {[...primary, ...secondary].map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="rounded border border-wx-line px-3 py-2 text-sm text-wx-fg hover:bg-wx-ink"
                  onClick={() => setOpen(false)}
                >
                  {l.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
