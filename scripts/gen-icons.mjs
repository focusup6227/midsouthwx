// Regenerate PWA + favicon icons from public/icons/logo.png using macOS `sips`.
// Outputs: public/icons/{icon-192,icon-512,apple-touch-icon,favicon-16,favicon-32}.png
//          public/favicon.ico (PNG bytes — browsers content-sniff this fine)
//
// Usage: node scripts/gen-icons.mjs
// Requires: macOS (sips ships with the OS). On Linux, swap in ImageMagick `convert`.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const iconsDir = resolve(repo, 'public', 'icons');
const source = resolve(iconsDir, 'logo.png');

if (!existsSync(source)) {
  console.error(`error: ${source} not found. Drop the master logo there first.`);
  process.exit(1);
}

mkdirSync(iconsDir, { recursive: true });

const sipsCheck = spawnSync('which', ['sips']);
if (sipsCheck.status !== 0) {
  console.error('error: sips not found (macOS only). On Linux, run `convert` from ImageMagick instead.');
  process.exit(1);
}

const sizes = [
  { size: 16,  out: 'favicon-16.png' },
  { size: 32,  out: 'favicon-32.png' },
  { size: 180, out: 'apple-touch-icon.png' },
  { size: 192, out: 'icon-192.png' },
  { size: 512, out: 'icon-512.png' },
];

for (const { size, out } of sizes) {
  const outPath = resolve(iconsDir, out);
  execFileSync('sips', [
    '-Z', String(size), '--setProperty', 'format', 'png',
    source, '--out', outPath,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`wrote ${outPath}`);
}

// /favicon.ico — browsers content-sniff, so PNG bytes at this path work.
const faviconIco = resolve(repo, 'public', 'favicon.ico');
copyFileSync(resolve(iconsDir, 'favicon-32.png'), faviconIco);
console.log(`wrote ${faviconIco}`);
