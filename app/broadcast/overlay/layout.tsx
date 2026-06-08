import type { ReactNode } from 'react';

// OBS browser sources capture this page as a layer composited over the video,
// so the background MUST be transparent. OBS injects transparency by default,
// but we force it here too so the overlay previews correctly in a plain
// browser tab. No DashShell, no chrome — just the overlay.
export const metadata = {
  title: 'Broadcast overlay',
  robots: { index: false, follow: false },
};

export default function OverlayLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* eslint-disable-next-line react/no-unknown-property */}
      <style>{`html,body{background:transparent !important;margin:0;overflow:hidden;}`}</style>
      <div className="fixed inset-0 overflow-hidden text-white antialiased" style={{ background: 'transparent' }}>
        {children}
      </div>
    </>
  );
}
