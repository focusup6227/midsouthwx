// Fork Mapbox's dark-v11 into a private Mid-South WX style with all the
// nuisance layers hidden and the labels/roads boosted up-front. The radar
// then points `NEXT_PUBLIC_MAPBOX_STYLE` at the new URL and the imperative
// boostBasemapLegibility() in RadarView.tsx becomes redundant.
//
// Requires a Mapbox **secret** token (sk.*) with scopes `styles:read`,
// `styles:write`, `styles:list`. Add to .env.local as MAPBOX_SECRET_TOKEN.
//
// Usage:
//   node scripts/clone-mapbox-style.mjs            # create a fresh fork
//   node scripts/clone-mapbox-style.mjs --update STYLEID  # patch existing
//
// Output: prints `mapbox://styles/<user>/<id>` — copy into .env.local.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env.local');

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const SECRET = env.MAPBOX_SECRET_TOKEN;
if (!SECRET) {
  console.error(
    'MAPBOX_SECRET_TOKEN missing in .env.local. Generate at:\n' +
      '  https://account.mapbox.com/access-tokens/\n' +
      'Required scopes: styles:read, styles:write, styles:list',
  );
  process.exit(1);
}

const username = (() => {
  // Mapbox tokens are JWTs; the username sits in payload.u
  try {
    const payload = SECRET.split('.')[1];
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return json.u;
  } catch {
    return null;
  }
})();

if (!username) {
  console.error('Could not extract username from MAPBOX_SECRET_TOKEN.');
  process.exit(1);
}

const args = process.argv.slice(2);
const updateIdx = args.indexOf('--update');
const updateId = updateIdx >= 0 ? args[updateIdx + 1] : null;

// ── 1. Pull the canonical dark-v11 ───────────────────────────────────────
console.log('Fetching mapbox/dark-v11…');
const baseRes = await fetch(
  `https://api.mapbox.com/styles/v1/mapbox/dark-v11?access_token=${SECRET}`,
);
if (!baseRes.ok) {
  console.error(`fetch dark-v11 failed: ${baseRes.status} ${await baseRes.text()}`);
  process.exit(1);
}
const base = await baseRes.json();

// ── 2. Apply the same patches boostBasemapLegibility does at runtime ─────
// Keeps the source of truth in one place (this script) once you adopt the
// forked style — at that point you can remove the imperative boost in
// RadarView.tsx, since the style ships pre-tuned.
const isMatch = (re, type) => (l) => re.test(l.id ?? '') && l.type === type;
const NUISANCE = (l) => {
  const id = l.id ?? '';
  if (/airport/i.test(id)) return false;
  return (
    /^poi-label/i.test(id) ||
    /^transit-label/i.test(id) ||
    /^building/i.test(id) ||
    /^landuse(-overlay)?/i.test(id) ||
    /^hillshade/i.test(id) ||
    /^pitch/i.test(id) ||
    /^natural-(line|point-label)/i.test(id) ||
    /^aerialway/i.test(id)
  );
};

const PATCHES = [
  // Hide nuisance.
  {
    match: NUISANCE,
    layout: { visibility: 'none' },
  },
  // Major roads.
  {
    match: isMatch(/(motorway|trunk|primary)/i, 'line'),
    paint: {
      'line-color': '#fde047',
      'line-opacity': 1,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 8, 2.8, 12, 5, 16, 9],
    },
  },
  // Mid roads.
  {
    match: isMatch(/(secondary|tertiary)/i, 'line'),
    paint: {
      'line-color': '#fcd34d',
      'line-opacity': 0.95,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 8, 1.6, 12, 3.5, 16, 6],
    },
  },
  // Minor roads — excluded above by precedence in runtime; here we match by
  // name and exclude major/mid via id substring.
  {
    match: (l) =>
      /(road|street|bridge|tunnel)/i.test(l.id ?? '') &&
      l.type === 'line' &&
      !/(motorway|trunk|primary|secondary|tertiary)/i.test(l.id ?? ''),
    paint: {
      'line-color': '#e2e8f0',
      'line-opacity': 0.85,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 12, 1.2, 16, 3],
    },
  },
  // Admin boundaries.
  {
    match: isMatch(/^admin-0/i, 'line'),
    paint: {
      'line-color': '#ffffff',
      'line-opacity': 0.95,
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.4, 10, 3],
    },
  },
  {
    match: isMatch(/^admin-1/i, 'line'),
    paint: {
      'line-color': '#f1f5f9',
      'line-opacity': 0.9,
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 10, 2.4],
    },
  },
  {
    match: isMatch(/^admin-2/i, 'line'),
    paint: {
      'line-color': '#cbd5e1',
      'line-opacity': 0.75,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 12, 1.4],
    },
  },
  // Place / settlement / state / country / airport / waterway labels.
  {
    match: (l) =>
      /settlement|place-label|place-|state-label|country-label|airport-label|waterway-label|water-(point|line)-label/i.test(
        l.id ?? '',
      ) && l.type === 'symbol',
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': '#0b1220',
      'text-halo-width': 2.6,
      'text-halo-blur': 0,
    },
    layout: {
      'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 8, 14, 12, 17, 16, 22],
    },
  },
  // Highway shields.
  {
    match: isMatch(/shield/i, 'symbol'),
    layout: {
      visibility: 'visible',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 8, 1.1, 12, 1.4, 16, 1.7],
      'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 8, 12, 12, 14, 16, 17],
      'symbol-spacing': 200,
      'icon-allow-overlap': true,
      'text-allow-overlap': false,
    },
    paint: {
      'icon-opacity': 1,
      'text-color': '#ffffff',
      'text-halo-color': '#0b1220',
      'text-halo-width': 1.4,
    },
  },
  // Road name labels.
  {
    match: isMatch(/road-label|road-intersection/i, 'symbol'),
    layout: {
      visibility: 'visible',
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 13, 18, 16],
    },
    paint: {
      'text-color': '#fef3c7',
      'text-halo-color': '#0b1220',
      'text-halo-width': 1.6,
    },
  },
];

let touched = 0;
for (const layer of base.layers) {
  for (const p of PATCHES) {
    if (!p.match(layer)) continue;
    if (p.layout) {
      layer.layout = { ...(layer.layout ?? {}), ...p.layout };
    }
    if (p.paint) {
      layer.paint = { ...(layer.paint ?? {}), ...p.paint };
    }
    touched++;
  }
}
console.log(`Patched ${touched} layer entries (across ${base.layers.length} total).`);

// ── 3. Trim fields the Mapbox API rejects on POST/PATCH ──────────────────
const forkName = 'Mid-South WX (forked dark-v11)';
base.name = forkName;
delete base.id;
delete base.owner;
delete base.created;
delete base.modified;
delete base.visibility;
delete base.protected;
delete base.draft;

// ── 4. Create or update ──────────────────────────────────────────────────
const endpoint = updateId
  ? `https://api.mapbox.com/styles/v1/${username}/${updateId}?access_token=${SECRET}`
  : `https://api.mapbox.com/styles/v1/${username}?access_token=${SECRET}`;

console.log(updateId ? `Updating style ${updateId}…` : 'Creating new style…');
const res = await fetch(endpoint, {
  method: updateId ? 'PATCH' : 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(base),
});
if (!res.ok) {
  console.error(`${updateId ? 'PATCH' : 'POST'} failed: ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}
const out = await res.json();
const styleUrl = `mapbox://styles/${username}/${out.id}`;

console.log('');
console.log('━'.repeat(60));
console.log('  Style URL:', styleUrl);
console.log('  Style ID :', out.id);
console.log('━'.repeat(60));
console.log('');
console.log('Next step: add to .env.local');
console.log('  NEXT_PUBLIC_MAPBOX_STYLE=' + styleUrl);
console.log('');
console.log('Then update RadarView.tsx to use it (mapStyle prop). The');
console.log('imperative boostBasemapLegibility() can stay as belt-and-');
console.log('suspenders or be removed once you confirm parity.');
