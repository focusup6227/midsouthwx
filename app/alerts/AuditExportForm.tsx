'use client';

export default function AuditExportForm() {
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 86400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const DateFields = ({ idPrefix }: { idPrefix: string }) => (
    <>
      <label className="block">
        <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">From</span>
        <input
          type="date"
          name="from"
          className="input"
          defaultValue={fmt(monthAgo)}
          id={`${idPrefix}-from`}
        />
      </label>
      <label className="block">
        <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">To</span>
        <input
          type="date"
          name="to"
          className="input"
          defaultValue={fmt(today)}
          id={`${idPrefix}-to`}
        />
      </label>
    </>
  );

  return (
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <form className="flex flex-wrap items-end gap-3" action="/alerts/export" method="GET">
        <DateFields idPrefix="alerts" />
        <button type="submit" className="btn-ghost">
          Export alerts CSV
        </button>
      </form>
      <form className="flex flex-wrap items-end gap-3" action="/alerts/export" method="GET">
        <input type="hidden" name="kind" value="delivery" />
        <DateFields idPrefix="delivery" />
        <button type="submit" className="btn-ghost">
          Export delivery log CSV
        </button>
      </form>
    </div>
  );
}
