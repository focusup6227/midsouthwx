/**
 * Workaround for mapbox-gl@3.24.0 crash:
 *
 *   TypeError: Cannot read properties of undefined (reading 'get')
 *     at us.update                 (terrain.update)
 *     at sc.updateTerrain          (style.updateTerrain)
 *     at Map._updateTerrain
 *     at Map.removeSource          ← triggers the failing path
 *
 * Repro: any <Source> unmount during normal radar interaction. The bug is
 * inside `_updateTerrain()` — it dereferences a `sourceCache.get(...)` for
 * the source we *just* removed. We don't configure 3-D terrain at all, but
 * mapbox-gl still routes through this code path on every removeSource().
 *
 * The bug is upstream and present in the latest 3.x. Until they ship a fix
 * we wrap `Map.prototype.removeSource` and swallow the specific TypeError
 * raised by the terrain update. The actual source removal already
 * completed before the crash — `style.removeSource(id)` runs before
 * `_updateTerrain()` in the upstream method body — so this is safe.
 *
 * Import this module once, ahead of any <Map> render. It patches the
 * prototype globally and exits.
 */

import mapboxgl from 'mapbox-gl';

const PATCHED = Symbol.for('midsouthwx.mapbox.removeSource.patched');

type MapProto = typeof mapboxgl.Map.prototype & { [PATCHED]?: boolean };

const proto = mapboxgl.Map.prototype as MapProto;
if (!proto[PATCHED]) {
  const original = proto.removeSource;
  proto.removeSource = function (this: mapboxgl.Map, id: string) {
    try {
      return original.call(this, id);
    } catch (err) {
      // Only swallow the specific terrain-race TypeError. Anything else
      // (e.g. "source not found") is a real bug we want to surface.
      if (
        err instanceof TypeError &&
        /reading 'get'/.test(err.message)
      ) {
        if (typeof console !== 'undefined') {
          console.warn(
            `[mapbox-gl patch] swallowed terrain race on removeSource("${id}")`,
          );
        }
        return this;
      }
      throw err;
    }
  };
  proto[PATCHED] = true;
}

export {};
