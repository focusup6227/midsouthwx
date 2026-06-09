import type { ReactNode } from 'react';

// Full-frame broadcast scenes (standby / BRB / outro / headlines board). Unlike
// the transparent overlays, these are OPAQUE backgrounds the operator uses as a
// dedicated OBS scene or screen-records directly. Cookieless (OBS) — on the
// middleware public allowlist, public NWS data only.
export const metadata = {
  title: 'Broadcast scene',
  robots: { index: false, follow: false },
};

export default function SceneLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style>{`html,body{margin:0;overflow:hidden;background:#0b1220;}`}</style>
      <div className="fixed inset-0 overflow-hidden bg-wx-ink text-white antialiased">{children}</div>
    </>
  );
}
