import type { Map, MapSourceDataEvent } from 'maplibre-gl';

export type MapWorkerState = 'idle' | 'pending' | 'ok' | 'timeout' | 'aborted' | 'blocked' | 'error';

/**
 * Check the actual MapLibre Worker using only public source APIs. GeoJSON
 * `content` follows a Worker round trip; `style.load` alone proves neither
 * Worker startup nor a working basemap. The empty source needs no network.
 * A timeout is a warning, not proof the engine is unusable; accept late replies.
 */
export function watchMapWorker(map: Map, report: (state: MapWorkerState) => void): () => void {
  let generation = 0;
  let cancel: (() => void) | undefined;
  const start = () => {
    cancel?.();
    // Distinct IDs prevent a late event from an old style completing a new check.
    const id = `__cartula_worker_check_${++generation}`;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      map.off('sourcedata', onData);
      map.off('dataabort', onAbort);
      // A style replacement may already have removed the source.
      try { if (map.getSource(id)) map.removeSource(id); } catch { /* style was removed */ }
    };
    const onData = (event: MapSourceDataEvent) => {
      if (event.sourceId !== id || event.sourceDataType !== 'content') return;
      cleanup();
      report('ok');
    };
    const onAbort = (event: MapSourceDataEvent) => {
      if (event.sourceId !== id) return;
      cleanup();
      report('aborted');
    };
    cancel = cleanup;
    report('pending');
    map.on('sourcedata', onData);
    map.on('dataabort', onAbort);
    timer = setTimeout(() => report('timeout'), 10_000);
    try {
      map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    } catch {
      cleanup();
      report('error');
    }
  };
  map.on('style.load', start);
  return () => {
    map.off('style.load', start);
    cancel?.();
  };
}
