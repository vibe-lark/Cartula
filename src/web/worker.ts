import { setWorkerCount, setWorkerUrl } from 'maplibre-gl';
import source from 'virtual:cartula-worker';

let workerUrl: string | undefined;
export function configureMapWorker() {
  workerUrl ??= URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  setWorkerCount(1);
  // MapLibre 6 selects classic Workers when the URL ends in .cjs. A fragment
  // preserves the blob identity (a query would not). Keep this paired with the
  // IIFE build and the real-Worker regression test when upgrading MapLibre.
  // Module blob Workers fail asynchronously in Chromium's opaque srcdoc frames.
  setWorkerUrl(`${workerUrl}#cartula-worker.cjs`);
}
