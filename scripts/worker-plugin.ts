import { build } from 'esbuild';
import type { Plugin } from 'vite';

/** Bundle the complete graph as a classic Worker for opaque MCP App frames. */
export function cartulaWorker(): Plugin {
  let source: Promise<string> | undefined;
  return {
    name: 'cartula-inline-map-worker',
    resolveId(id) { if (id === 'virtual:cartula-worker') return '\0cartula-worker'; },
    async load(id) {
      if (id !== '\0cartula-worker') return;
      source ??= build({
        entryPoints: ['node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'],
        bundle: true, write: false, minify: true, format: 'iife', platform: 'browser', target: 'es2022',
        // ESM was implicitly strict; preserve that when changing the wrapper.
        banner: { js: '"use strict";' },
      }).then(result => result.outputFiles[0].text);
      return `export default ${JSON.stringify(await source)};`;
    },
  };
}
