const STYLES: Record<string, { label: string; cls: string }> = {
  county: {
    label: 'County',
    cls: 'border-sky-500/40 text-sky-300 bg-sky-500/10',
  },
  zone: {
    label: 'NWS zone',
    cls: 'border-violet-500/40 text-violet-300 bg-violet-500/10',
  },
  custom_polygon: {
    label: 'Custom',
    cls: 'border-amber-500/40 text-amber-300 bg-amber-500/10',
  },
};

export default function KindBadge({ kind }: { kind: string }) {
  const s = STYLES[kind] ?? { label: kind, cls: 'border-wx-line text-wx-mute' };
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${s.cls}`}
    >
      {s.label}
    </span>
  );
}
