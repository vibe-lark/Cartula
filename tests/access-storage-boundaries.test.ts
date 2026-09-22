import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceStore } from '../src/web/adapters/access.js';

test('claiming in another tab removes the remembered default key as well as each map key', () => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    getItem: name => values.get(name) ?? null,
    setItem: (name, value) => { values.set(name, value); },
    removeItem: name => { values.delete(name); },
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
  };
  const firstTab = createSpaceStore(storage);
  const secondTab = createSpaceStore(storage);
  firstTab.write('space-A');
  firstTab.remember('map-A', 'space-A');
  assert.equal(secondTab.read(), 'space-A');
  assert.equal(secondTab.forMap('map-A'), 'space-A');
  secondTab.forget('space-A');
  assert.equal(firstTab.read(), undefined, 'a successful empty storage read must not revive a stale in-memory key');
  assert.equal(firstTab.forMap('map-A'), undefined);
  firstTab.remember('map-B', 'space-B');
  assert.equal(createSpaceStore(storage).forMap('map-A'), undefined);
});
