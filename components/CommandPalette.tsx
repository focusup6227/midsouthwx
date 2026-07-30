'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { PRIMARY_NAV, SECONDARY_NAV, EXTRA_PALETTE_NAV, type NavItem } from './nav-data';

type SubscriberHit = { id: string; name: string; status: string; zip: string | null; linked: boolean };

type Row =
  | { type: 'nav'; href: string; label: string }
  | { type: 'subscriber'; href: string; label: string; detail: string };

const ALL_NAV: NavItem[] = [...EXTRA_PALETTE_NAV.slice(0, 1), ...PRIMARY_NAV, ...SECONDARY_NAV, ...EXTRA_PALETTE_NAV.slice(1)];

function matchNav(q: string): NavItem[] {
  if (!q) return ALL_NAV.slice(0, 12);
  const needle = q.toLowerCase();
  return ALL_NAV.filter(
    (i) => i.label.toLowerCase().includes(needle) || (i.keywords ?? '').includes(needle)
  ).slice(0, 12);
}

/**
 * Global ⌘K / Ctrl+K command palette: jump to any page, search subscribers
 * by name or ZIP. Mounted once in DashShell.
 */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [subs, setSubs] = useState<SubscriberHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSubs([]);
      setCursor(0);
      // Focus after the dialog paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced subscriber search.
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setSubs([]);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/palette/subscribers?q=${encodeURIComponent(query.trim())}`);
        if (!res.ok) return;
        const body = (await res.json()) as { subscribers: SubscriberHit[] };
        setSubs(body.subscribers);
      } catch {
        /* palette search is best-effort */
      }
    }, 200);
    return () => window.clearTimeout(t);
  }, [open, query]);

  const rows: Row[] = useMemo(() => {
    const nav: Row[] = matchNav(query.trim()).map((i) => ({ type: 'nav', href: i.href, label: i.label }));
    const sub: Row[] = subs.map((s) => ({
      type: 'subscriber',
      href: `/subscribers/${s.id}`,
      label: s.name,
      detail: [s.status, s.zip ? `ZIP ${s.zip}` : null, s.linked ? null : 'unlinked'].filter(Boolean).join(' · '),
    }));
    return [...nav, ...sub];
  }, [query, subs]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const go = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      setOpen(false);
      router.push(row.href);
    },
    [router]
  );

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(rows[cursor]);
    }
  };

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search (Cmd+K)"
        title="Search · ⌘K"
        className="hidden items-center gap-1.5 rounded-md border border-wx-line px-2 py-1 text-xs text-wx-mute hover:text-wx-fg md:inline-flex"
      >
        <Search size={13} />
        <kbd className="font-sans">⌘K</kbd>
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="mx-auto mt-[10vh] w-[min(560px,92vw)] overflow-hidden rounded-xl border border-wx-line bg-wx-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
          >
            <div className="flex items-center gap-2 border-b border-wx-line px-3">
              <Search size={16} className="shrink-0 text-wx-mute" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKey}
                placeholder="Jump to a page or search subscribers…"
                className="w-full bg-transparent py-3 text-sm text-wx-fg outline-none placeholder:text-wx-mute"
                aria-label="Search pages and subscribers"
              />
            </div>
            <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
              {rows.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-wx-mute">No matches</div>
              ) : (
                rows.map((row, i) => (
                  <button
                    key={`${row.type}-${row.href}`}
                    type="button"
                    data-row={i}
                    onClick={() => go(row)}
                    onMouseEnter={() => setCursor(i)}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${
                      i === cursor ? 'bg-wx-accent/10 text-wx-accent' : 'text-wx-fg'
                    }`}
                  >
                    <span className="truncate">{row.label}</span>
                    <span className="shrink-0 text-xs text-wx-mute">
                      {row.type === 'subscriber' ? (row as Extract<Row, { type: 'subscriber' }>).detail : row.href}
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="border-t border-wx-line px-3 py-1.5 text-[10px] text-wx-mute">
              ↑↓ navigate · Enter open · Esc close · type 2+ letters to search subscribers
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
