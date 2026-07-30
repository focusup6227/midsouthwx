// Single source of truth for dashboard navigation. Consumed by DashShell
// (header + mobile menus) and CommandPalette (⌘K jump list).

export type NavItem = { href: string; label: string; keywords?: string };

export const PRIMARY_NAV: NavItem[] = [
  { href: '/compose', label: 'Compose', keywords: 'send alert message new' },
  { href: '/inbox', label: 'Inbox', keywords: 'replies conversations messages' },
  { href: '/schedule', label: 'Schedule', keywords: 'recurring scheduled' },
  { href: '/nws', label: 'NWS', keywords: 'warnings approval rules auto' },
  { href: '/radar', label: 'Radar', keywords: 'nexrad map storm' },
  { href: '/briefing', label: 'Briefing', keywords: 'spc afd outlook' },
  { href: '/forecast/workflow', label: 'Forecast', keywords: 'outlook workflow' },
  { href: '/broadcast', label: 'Broadcast', keywords: 'youtube obs stream teleprompter' },
  { href: '/map', label: 'Map', keywords: 'subscribers regions' },
];

export const SECONDARY_NAV: NavItem[] = [
  { href: '/subscribers', label: 'Subscribers', keywords: 'people users members' },
  { href: '/groups', label: 'Groups', keywords: 'audience' },
  { href: '/regions', label: 'Regions', keywords: 'polygons areas zones' },
  { href: '/alerts', label: 'Alerts', keywords: 'sent history audit' },
  { href: '/reports', label: 'Reports', keywords: 'storm spotter lsr' },
  { href: '/forecast/skill', label: 'Forecast skill', keywords: 'verification metrics' },
  { href: '/analytics/warnings', label: 'Verification', keywords: 'analytics warnings' },
  { href: '/checkins', label: 'Check-ins', keywords: 'safe distress safety' },
  { href: '/log', label: 'Log', keywords: 'notes events journal' },
  { href: '/health', label: 'Health', keywords: 'status queue monitoring' },
  { href: '/settings', label: 'Settings', keywords: 'templates password integrations' },
];

export const EXTRA_PALETTE_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', keywords: 'home overview' },
  { href: '/schedule/new', label: 'New scheduled message', keywords: 'schedule create' },
  { href: '/forecast/new', label: 'New forecast', keywords: 'create outlook' },
  { href: '/regions/new', label: 'New region', keywords: 'create polygon' },
  { href: '/regions/import', label: 'Import regions', keywords: 'shapefile upload' },
  { href: '/subscribers/invite', label: 'Invite subscriber', keywords: 'add person signup' },
  { href: '/broadcast/teleprompter', label: 'Teleprompter', keywords: 'script prompter' },
  { href: '/analytics/couplets', label: 'Rotation validation', keywords: 'couplet tds hit rate far verification' },
  { href: '/forecast/templates', label: 'Forecast templates', keywords: '' },
];
