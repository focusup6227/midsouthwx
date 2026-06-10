import Link from 'next/link';
import Image from 'next/image';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import FieldModeToggle from './FieldModeToggle';
import HealthIndicator from './HealthIndicator';
import NotificationPermissionButton from './NotificationPermissionButton';
import SevereAlertAudio from './SevereAlertAudio';
import StormReportAudio from './StormReportAudio';
import MobileNavOverlay from './MobileNavOverlay';
import MobileNavMenu from './MobileNavMenu';
import OpsStatusBadges from './OpsStatusBadges';
import NavLinks from './NavLinks';

type Props = {
  title?: string;
  actions?: ReactNode;
  backHref?: string;
  width?: 'narrow' | 'normal' | 'wide' | 'full';
  bare?: boolean;
  /** Collapse the entire sticky header into a floating hamburger on mobile.
   *  Used by full-bleed pages (radar) so the map gets the full viewport. */
  mobileCompact?: boolean;
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
  bare = false,
  mobileCompact = false,
  children,
}: Props) {
  const field = await isFieldMode();

  type NavLink = { href: string; label: string; extra?: ReactNode };
  const primary: NavLink[] = [
    { href: '/compose', label: 'Compose' },
    { href: '/inbox', label: 'Inbox' },
    { href: '/schedule', label: 'Schedule' },
    { href: '/nws', label: 'NWS' },
    { href: '/radar', label: 'Radar' },
    { href: '/briefing', label: 'Briefing' },
    { href: '/forecast/workflow', label: 'Forecast' },
    { href: '/broadcast', label: 'Broadcast' },
    { href: '/map', label: 'Map' },
  ];

  const secondary: NavLink[] = [
    { href: '/subscribers', label: 'Subscribers' },
    { href: '/groups', label: 'Groups' },
    { href: '/regions', label: 'Regions' },
    { href: '/alerts', label: 'Alerts' },
    { href: '/reports', label: 'Reports' },
    { href: '/forecast/skill', label: 'Forecast skill' },
    { href: '/analytics/warnings', label: 'Verification' },
    { href: '/checkins', label: 'Check-ins' },
    { href: '/log', label: 'Log' },
    { href: '/health', label: 'Health' },
    { href: '/settings', label: 'Settings' },
  ];

  return (
    <>
      <SevereAlertAudio />
      <StormReportAudio />
      {mobileCompact ? (
        <>
          <MobileNavOverlay primary={primary} secondary={secondary} field={field} />
          {/* Approval/distress badges float beside the hamburger on compact
              pages (radar) where the header is hidden. */}
          <OpsStatusBadges floating />
        </>
      ) : null}
      <header
        className={`sticky top-0 z-30 border-b border-wx-line bg-wx-ink/95 backdrop-blur ${
          mobileCompact ? 'hidden tallmd:block' : ''
        }`}
      >
        <nav className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold whitespace-nowrap">
            <Image src="/icons/icon-192.png" alt="" width={28} height={28} className="rounded-full" />
            MidSouthWX
          </Link>
          <NavLinks links={primary.map(({ href, label }) => ({ href, label }))} />
          <div className="ml-auto flex items-center gap-2">
            <OpsStatusBadges />
            <HealthIndicator />
            <NotificationPermissionButton />
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
            <MobileNavMenu links={[...primary, ...secondary]} />
          </div>
        </nav>
      </header>
      {bare ? (
        <main className="w-full">{children}</main>
      ) : (
      <main className={`mx-auto ${WIDTHS[width]} space-y-4 p-3 sm:space-y-6 sm:p-6`}>
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
      )}
    </>
  );
}
