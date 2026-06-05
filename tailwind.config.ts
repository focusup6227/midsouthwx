import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      screens: {
        // Width AND height gate for the desktop dashboard chrome. Landscape
        // phones are wide (>=768px) but short (~390px tall), so a plain `md`
        // width check renders the full nav bar and subtracts a header that
        // eats the limited vertical space. Require real vertical room before
        // showing desktop chrome; otherwise the radar/map full-bleed compact
        // layout (floating hamburger) kicks in.
        tallmd: { raw: '(min-width: 768px) and (min-height: 500px)' },
      },
      colors: {
        wx: {
          ink: '#0b1220',
          card: '#111827',
          line: '#1f2937',
          mute: '#64748b',
          fg: '#e5e7eb',
          accent: '#fbbf24',
          danger: '#ef4444',
          ok: '#10b981',
        },
      },
    },
  },
  plugins: [],
};
export default config;
