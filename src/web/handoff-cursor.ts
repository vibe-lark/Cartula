/**
 * "Already handed over", per map, across reloads.
 *
 * The cursor is the boundary of a hand-off: everything above it is what 继续规划
 * will describe next time. It only ever moves when a round was confirmed — the
 * host accepted the message, or the user copied it — so it is not derivable
 * from the map, whose `draft.commit` records a submission that may never have
 * reached anybody.
 *
 * Holding it in memory alone made a reload a silent reset to 0, and an embedded
 * App is reloaded by things the user did not do: a host re-rendering the widget,
 * a frame restored after a navigation. The whole change log was then offered as
 * "this round" and handed over a second time. The two failure directions are not
 * symmetric, which is what the rules below follow:
 *
 *  - A cursor that lags re-offers changes the agent has already seen. Noisy,
 *    visible, recoverable.
 *  - A cursor that runs ahead silently drops changes nobody ever handed over.
 *    Nothing in the UI can show what was skipped.
 *
 * So the cursor only moves forward, a stored value that cannot describe the map
 * in front of it (ahead of its version) is discarded rather than trusted, and
 * any storage failure degrades to memory instead of throwing.
 *
 * Storage is not always there to hold it. An App embedded in a sandboxed frame
 * has an opaque origin, where every web storage API throws. The durable copy
 * therefore lives on the server (`record_handoff`, reported back as
 * `MapSnapshot.handoffVersion`), and this class merges it as a floor.
 *
 * Nothing else may supply that floor. The map's history cannot: a `draft.commit`
 * records a submission, and a later Agent version does not prove that
 * submission was ever delivered — the message may have been refused or timed
 * out while the Agent wrote for its own reasons. Inferring a hand-off from that
 * pair would silently drop the user's changes. The Agent's own write cursor
 * (`MapSnapshot.agentVersion`) is out for the same reason: it says when the
 * Agent last wrote, not whether anybody handed the user's edits over.
 *
 * Pure module apart from the injected storage: `src/web/main.tsx` wires it to
 * the browser, and the tests inject their own.
 */
import type { MapSnapshot } from '../core/types.js';

/** The slice of `Storage` this needs. Injected so it can be tested and can fail. */
export interface CursorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'cartula:submitted:';

/**
 * Where a hand-off cursor survives.
 *
 * `localStorage` first, because reopening the map — a new tab, a host that
 * rebuilt its frame — is exactly the case a per-tab store cannot cover;
 * `sessionStorage` as well, both because a partitioned frame may only have that
 * one and because sessions written by earlier builds live there. Reads take the
 * larger of the two: the cursor is monotonic, so the newer value is the higher
 * one either way.
 */
export function browserCursorStorages(): CursorStorage[] {
  const stores: CursorStorage[] = [];
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      const store = (globalThis as unknown as Record<string, CursorStorage | undefined>)[name];
      // Touching it is the only way to know: a frame with storage blocked
      // throws on access, not on construction.
      if (store && typeof store.getItem === 'function') { store.getItem(`${PREFIX}probe`); stores.push(store); }
    } catch { /* Storage denied in this frame; memory still works. */ }
  }
  return stores;
}

/** A version number a cursor may legitimately hold. */
function versionOf(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The boundary this map itself carries: the server's record of a delivery the
 * view confirmed (`record_handoff`). That record is the only durable evidence
 * that a round reached the conversation, and it is what a reopened frame with
 * no storage reads back.
 *
 * A round that was submitted but whose acknowledgement never landed stays on
 * offer. That costs a repeated round — recoverable, visible — where guessing
 * would cost somebody's changes.
 */
export function handoffFloor(map: Pick<MapSnapshot, 'handoffVersion'> | undefined): number {
  return versionOf(map?.handoffVersion) ?? 0;
}

export class HandoffCursor {
  private memory = new Map<string, number>();
  constructor(private stores: CursorStorage[] = []) {}
  /**
   * The version this map was last handed over at.
   *
   * `currentVersion` is what the view is holding. A stored cursor above it
   * cannot be about this map as it now exists — a different map reusing an id,
   * or a record from a restored copy — and trusting it would hide every change
   * in between, so it is forgotten and the caller starts from the beginning.
   *
   * `confirmed` is the server's own boundary (see `handoffFloor`). It is a
   * floor rather than an override: this side may have confirmed a delivery
   * whose acknowledgement has not reached the server yet, and that round has
   * still been handed over.
   */
  read(mapId: string, currentVersion?: number, confirmed = 0): number {
    const stored = this.stores.flatMap(store => {
      try { return [versionOf(store.getItem(PREFIX + mapId))].filter(value => value !== undefined); }
      catch { return []; }
    });
    let known = Math.max(this.memory.get(mapId) ?? 0, ...stored);
    if (currentVersion !== undefined && known > currentVersion) { this.forget(mapId); known = 0; }
    return Math.max(known, versionOf(confirmed) ?? 0);
  }
  /**
   * Record a confirmed hand-off. Only forward: a late copy, or a confirmation
   * belonging to an earlier round, must not pull the boundary back and re-offer
   * what was already submitted.
   */
  mark(mapId: string, version: number): number {
    const next = Math.max(versionOf(version) ?? 0, this.memory.get(mapId) ?? 0, this.read(mapId));
    this.memory.set(mapId, next);
    for (const store of this.stores) {
      try { store.setItem(PREFIX + mapId, String(next)); } catch { /* Full or denied; memory holds this session. */ }
    }
    return next;
  }
  private forget(mapId: string) {
    this.memory.delete(mapId);
    for (const store of this.stores) {
      try { store.removeItem(PREFIX + mapId); } catch { /* Nothing to undo. */ }
    }
  }
}
