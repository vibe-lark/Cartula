import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { watchMapWorker, type MapWorkerState } from '../src/web/map-worker-health.js';

class SourceMap extends EventEmitter {
  sources = new Map<string, unknown>();
  addSource(id: string, source: unknown) { this.sources.set(id, source); }
  getSource(id: string) { return this.sources.get(id); }
  removeSource(id: string) {
    this.sources.delete(id);
    this.emit('dataabort', { sourceId: id });
  }
  checkId() { return [...this.sources.keys()][0]; }
}

test('Worker health requires a content reply, not style or source metadata', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const map = new SourceMap(); const states: MapWorkerState[] = [];
  const dispose = watchMapWorker(map as unknown as MapLibreMap, state => states.push(state));
  t.after(dispose);
  map.emit('style.load');
  const id = map.checkId();
  map.emit('sourcedata', { sourceId: id, sourceDataType: 'metadata' });
  map.emit('sourcedata', { sourceId: 'basemap', sourceDataType: 'content' });
  assert.deepEqual(states, ['pending']);
  map.emit('sourcedata', { sourceId: id, sourceDataType: 'content' });
  assert.deepEqual(states, ['pending', 'ok']);
  assert.equal(map.sources.size, 0);
  assert.equal(map.listenerCount('sourcedata'), 0);
  assert.equal(map.listenerCount('dataabort'), 0);
  t.mock.timers.tick(20_000);
  assert.deepEqual(states, ['pending', 'ok']);
});

test('a silent Worker times out, but a late reply clears the warning', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const map = new SourceMap(); const states: MapWorkerState[] = [];
  const dispose = watchMapWorker(map as unknown as MapLibreMap, state => states.push(state));
  t.after(dispose);
  map.emit('style.load');
  t.mock.timers.tick(10_000);
  assert.deepEqual(states, ['pending', 'timeout']);
  map.emit('sourcedata', { sourceId: map.checkId(), sourceDataType: 'content' });
  assert.deepEqual(states, ['pending', 'timeout', 'ok']);
  assert.equal(map.sources.size, 0);
});

test('style replacement cancels the old check and ignores its late replies', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const map = new SourceMap(); const states: MapWorkerState[] = [];
  const dispose = watchMapWorker(map as unknown as MapLibreMap, state => states.push(state));
  t.after(dispose);
  map.emit('style.load'); const first = map.checkId();
  map.removeSource(first);
  t.mock.timers.tick(20_000);
  assert.deepEqual(states, ['pending', 'aborted']);
  map.emit('style.load'); const second = map.checkId();
  assert.notEqual(first, second);
  map.emit('sourcedata', { sourceId: first, sourceDataType: 'content' });
  assert.equal(states.at(-1), 'pending');
  // Even without a dataabort event a new style must clean up the previous check.
  map.emit('style.load');
  assert.equal(map.sources.size, 1);
  assert.equal(map.listenerCount('sourcedata'), 1);
  map.emit('sourcedata', { sourceId: second, sourceDataType: 'content' });
  assert.equal(states.at(-1), 'pending');
  map.emit('sourcedata', { sourceId: map.checkId(), sourceDataType: 'content' });
  assert.equal(states.at(-1), 'ok');
});

test('unmount stops the timer, listeners and temporary source', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const map = new SourceMap(); const states: MapWorkerState[] = [];
  const dispose = watchMapWorker(map as unknown as MapLibreMap, state => states.push(state));
  map.emit('style.load');
  dispose(); dispose();
  t.mock.timers.tick(20_000);
  map.emit('style.load');
  assert.deepEqual(states, ['pending']);
  assert.equal(map.sources.size, 0);
  assert.equal(map.listenerCount('style.load'), 0);
  assert.equal(map.listenerCount('sourcedata'), 0);
  assert.equal(map.listenerCount('dataabort'), 0);
});

test('a source setup failure reports an error without leaving a timeout', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const map = new SourceMap(); const states: MapWorkerState[] = [];
  map.addSource = () => { throw new Error('source unavailable'); };
  const dispose = watchMapWorker(map as unknown as MapLibreMap, state => states.push(state));
  t.after(dispose);
  map.emit('style.load');
  t.mock.timers.tick(20_000);
  assert.deepEqual(states, ['pending', 'error']);
  assert.equal(map.listenerCount('sourcedata'), 0);
});
