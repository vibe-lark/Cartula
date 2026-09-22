import { applyOperations, normalizeMap, toMapInput } from '../../core/model.js';
import { MapInputSchema } from '../../core/schema.js';
import type { EditOperation, MapInput, MapSnapshot } from '../../core/types.js';
import { download, type Adapter, type AdapterUpdate } from './types.js';
export function offlineDocument(snapshot: MapSnapshot): string {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  const root = clone.querySelector('#root'); if (root) root.innerHTML = '';
  let boot = clone.querySelector('#cartula-bootstrap');
  if (!boot) { boot = document.createElement('script'); boot.id = 'cartula-bootstrap'; boot.setAttribute('type', 'application/json'); clone.querySelector('head')!.appendChild(boot); }
  boot.textContent = JSON.stringify({ mode: 'offline', snapshot }).replace(/</g, '\\u003c');
  return `<!doctype html>\n${clone.outerHTML}`;
}
export class OfflineAdapter implements Adapter {
  mode = 'offline' as const;
  editable = true;
  constructor(private snapshot: MapSnapshot) {}
  async initialize(onUpdate: (update: AdapterUpdate) => void) { onUpdate({ connection: 'offline' }); return this.snapshot; }
  async edit(snapshot: MapSnapshot, operations: EditOperation[]) {
    const result = applyOperations(snapshot, operations);
    if (!result.changes.length) return snapshot;
    const { operations: resolved, ...content } = result;
    const event = { version: snapshot.version + 1, actor: 'user' as const, at: new Date().toISOString(), changes: result.changes, operations: resolved };
    return { ...snapshot, ...content, events: [...snapshot.events, event], parent: snapshot.version, version: snapshot.version + 1, changed: true, changes: [...snapshot.changes, ...result.changes], updatedAt: new Date().toISOString() };
  }
  async replace(input: MapInput, snapshot: MapSnapshot) {
    const event = { version: snapshot.version + 1, actor: 'user' as const, at: new Date().toISOString(), changes: ['导入了新的图层数据'], operations: [{ op: 'replace' as const }] };
    return { ...snapshot, events: [...snapshot.events, event], ...normalizeMap(MapInputSchema.parse(input), snapshot, 'user'), parent: snapshot.version, version: snapshot.version + 1, changed: true, changes: [...snapshot.changes, '导入了新的图层数据'], updatedAt: new Date().toISOString() };
  }
  async export(snapshot: MapSnapshot, format: 'json' | 'html') {
    if (format === 'json') { download(JSON.stringify(toMapInput(snapshot), null, 2), `cartula-${snapshot.id}.json`); return; }
    download(offlineDocument(snapshot), `cartula-${snapshot.id}.html`, 'text/html');
  }
  dispose() {}
}
