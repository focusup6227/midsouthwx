/**
 * Route-transition skeleton for force-dynamic pages. Mounted via loading.tsx
 * so navigation shows immediate feedback instead of a frozen previous page.
 */
export default function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <main className="mx-auto max-w-5xl space-y-4 p-3 sm:space-y-6 sm:p-6" aria-busy="true" aria-label="Loading">
      <div className="h-8 w-48 animate-pulse rounded bg-wx-card" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card space-y-3 p-5">
          <div className="h-4 w-1/3 animate-pulse rounded bg-wx-line" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-wx-line/60" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-wx-line/60" />
        </div>
      ))}
    </main>
  );
}
