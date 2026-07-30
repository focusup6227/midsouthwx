'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Radar, PenSquare, Inbox, CloudLightning } from 'lucide-react';
import { isActivePath } from './NavLinks';

// Thumb-reach primary navigation for phones. The hamburger drawer still holds
// the full page list; these five are the storm-night workflow. Hidden on
// md+ (desktop header nav) and on full-bleed pages (radar/map render their
// own floating chrome — DashShell simply doesn't mount this there).
const TABS = [
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/radar', label: 'Radar', icon: Radar },
  { href: '/compose', label: 'Compose', icon: PenSquare },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/nws', label: 'NWS', icon: CloudLightning },
] as const;

export default function MobileTabBar() {
  const pathname = usePathname() ?? '';
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-wx-line bg-wx-ink/95 backdrop-blur md:hidden pb-[env(safe-area-inset-bottom)]"
    >
      <div className="grid h-14 grid-cols-5">
        {TABS.map((t) => {
          const active = isActivePath(pathname, t.href);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
                active ? 'text-wx-accent' : 'text-wx-mute active:text-wx-fg'
              }`}
            >
              <Icon size={20} strokeWidth={active ? 2.4 : 2} />
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
