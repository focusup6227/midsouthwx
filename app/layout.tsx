import './globals.css';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Metadata, Viewport } from 'next';
import ServiceWorkerRegistrar from './ServiceWorkerRegistrar';

export const metadata: Metadata = {
  title: 'MidSouthWX',
  description: 'Severe weather alert dashboard',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'MidSouthWX',
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#0b1220',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Warm TLS handshake to radar tile providers so the first tile after
            switching products skips ~200-400ms of connection setup. */}
        <link rel="preconnect" href="https://api.librewxr.net" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://opengeo.ncep.noaa.gov" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://thredds.ucar.edu" crossOrigin="anonymous" />
      </head>
      <body>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
