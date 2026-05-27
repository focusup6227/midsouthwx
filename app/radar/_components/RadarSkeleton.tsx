import { Radio } from 'lucide-react';

// Reserves the same dimensions as the live radar map so the page does not
// shift when the Mapbox bundle finishes loading. Matches the outer container
// in RadarView so hydration paints into the same box.
export default function RadarSkeleton() {
  return (
    <div className="h-[calc(100vh-3.5rem)] md:h-[calc(100vh-3.25rem)] flex flex-col bg-wx-ink text-wx-fg [contain:layout_paint]">
      <div className="flex-1 relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,#0f1729_0%,#070b14_70%)]" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-wx-muted">
          <Radio className="h-8 w-8 animate-pulse text-wx-accent" aria-hidden />
          <div className="text-sm tracking-wide">Loading radar…</div>
        </div>
        <div className="pointer-events-none absolute top-3 left-3 right-3 flex gap-2">
          <div className="h-8 w-32 rounded bg-white/5" />
          <div className="h-8 w-24 rounded bg-white/5" />
          <div className="h-8 flex-1 rounded bg-white/5" />
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 h-10 rounded bg-white/5" />
      </div>
    </div>
  );
}
