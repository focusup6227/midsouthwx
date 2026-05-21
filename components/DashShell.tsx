import Link from 'next/link';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { supabaseServer } from '@/lib/supabase/server';
import FieldModeToggle from './FieldModeToggle';

type Props = {
  title?: string;
  actions?: ReactNode;
  backHref?: string;
  width?: 'narrow' | 'normal' | 'wide' | 'full';
  children: ReactNode;
};

const WIDTHS: Record<NonNullable<Props['width']>, string> = {
  narrow: 'max-w-3xl',
  normal: 'max-w-5xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

export async function isFieldMode(): Promise<boolean> {
  return cookies().get('field-mode')?.value === '1';
}

export default async function DashShell({
  title,
  actions,
  backHref,
  width = 'normal',
  children,
}: Props) {
  const field = await isFieldMode();

  const supa = supabaseServer();
  const { count: unread } = await supa
    .from('replies')
    .select('*', { count: 'exact', head: true })
    .is('read_at', null);

  const inboxBadge =
    unread && unread > 0 ? (
      <span className="ml-1.5 inline-flex min-w-[1.25rem] justify-center rounded-full bg-wx-accent px-1.5 text-[11px] font-bold leading-5 text-black">
        {unread > 99 ? '99+' : unread}
      </span>
    ) : null;

  type NavLink = { href: string; label: string; extra?: ReactNode };
  const primary: NavLink[] = [
    { href: '/compose', label: 'Compose' },
    { href: '/inbox', label: 'Inbox', extra: inboxBadge },
    { href: '/schedule', label: 'Schedule' },
    { href: '/nws', label: 'NWS' },
    { href: '/radar', label: 'Radar' },
    { href: '/map', label: 'Map' },
  ];

  const secondary: NavLink[] = [
    { href: '/subscribers', label: 'Subscribers' },
    { href: '/groups', label: 'Groups' },
    { href: '/regions', label: 'Regions' },
    { href: '/alerts', label: 'Alerts' },
    { href: '/settings', label: 'Settings' },
  ];

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-wx-line bg-wx-ink/95 backdrop-blur">
        <nav className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
          <Link href="/dashboard" className="font-semibold whitespace-nowrap">
            Mid-South WX
          </Link>
          <div className="hidden flex-wrap items-center gap-1 md:flex">
            {primary.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="px-2.5 py-1 text-sm text-wx-mute hover:text-wx-fg"
              >
                {l.label}
                {l.extra}
              </Link>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <details className="relative hidden md:block">
              <summary className="cursor-pointer list-none px-2.5 py-1 text-sm text-wx-mute hover:text-wx-fg">
                More ▾
              </summary>
              <div className="absolute right-0 mt-1 w-44 rounded-lg border border-wx-line bg-wx-card py-1 shadow-lg">
                {secondary.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className="block px-3 py-1.5 text-sm text-wx-fg hover:bg-wx-ink"
                  >
                    {l.label}
                  </Link>
                ))}
              </div>
            </details>
            <FieldModeToggle active={field} />
          </div>
        </nav>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 md:hidden">
          {[...primary, ...secondary].map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="whitespace-nowrap rounded border border-wx-line px-2.5 py-1 text-xs text-wx-mute"
            >
              {l.label}
              {l.extra}
            </Link>
          ))}
        </nav>
      </header>
      <main className={`mx-auto ${WIDTHS[width]} space-y-6 p-6`}>
        {(title || actions || backHref) && (
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              {backHref ? (
                <Link href={backHref} className="text-sm text-wx-mute">
                  ← Back
                </Link>
              ) : null}
              {title ? <h1 className="text-2xl font-bold">{title}</h1> : null}
            </div>
            {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
          </div>
        )}
        {children}
      </main>
    </>
  );
}
