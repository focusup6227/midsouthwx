import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
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
