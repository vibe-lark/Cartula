/**
 * Adapter-side guards for out-of-order transport results.
 *
 * Tool results, polling reads and websocket refreshes race: a `get_map` issued
 * before an edit can land after it, and a result for the previous map can land
 * after the view switched to a new one. Both would otherwise roll the view back
 * to an older version, or graft one map's editing credential onto another.
 */

export interface Versioned {
  id: string;
  version: number;
}

/** A result that is older than what the view already holds for the same map. */
export function isStaleSnapshot(current: Versioned | undefined, incoming: Versioned): boolean {
  if (!current || current.id !== incoming.id) return false;
  return incoming.version < current.version;
}

/** Enough of a snapshot to say which slice of the history it carries. */
export interface Windowed extends Versioned {
  sinceVersion?: number;
  events?: unknown[];
}

/**
 * Whether a same-version result tells the view something it did not have.
 *
 * A write answers against the caller's own `baseVersion`, so its event list
 * covers that write alone. The poll that follows reads the whole history at the
 * same version — same numbers, more history — and the view needs it: the
 * un-handed-over count is derived from those events, and after two edits it
 * would otherwise show one. A version bump is not the only kind of news.
 */
export function widensWindow(current: Windowed | undefined, incoming: Windowed): boolean {
  if (!current || current.id !== incoming.id || incoming.version !== current.version) return false;
  const from = (value: Windowed) => value.sinceVersion ?? value.version;
  if (from(incoming) < from(current)) return true;
  return (incoming.events?.length ?? 0) > (current.events?.length ?? 0);
}

/**
 * Stable request id for logically identical retries.
 *
 * Server-side de-duplication keys on `requestId`, so minting a fresh one per
 * attempt turns one intent into several events. The id survives as long as the
 * payload does, and is dropped once the request succeeds.
 */
export class IdempotentRequest {
  private entry?: { key: string; requestId: string; baseVersion: number };
  constructor(private mint: () => string) {}
  /** The id to send for `key`; identical keys reuse the previous id and base version. */
  begin(key: string, baseVersion: number): { requestId: string; baseVersion: number } {
    if (!this.entry || this.entry.key !== key) this.entry = { key, requestId: this.mint(), baseVersion };
    return { requestId: this.entry.requestId, baseVersion: this.entry.baseVersion };
  }
  /** Call after the write is known to have been applied, or after a conflict reset. */
  clear() {
    this.entry = undefined;
  }
  get pending() {
    return this.entry !== undefined;
  }
}

/**
 * One in-flight hand-off, held immutable until its outcome is known.
 *
 * The payload — base version, the version this attempt is written against, the
 * request id and, once the server accepts it, the message and the version that
 * message describes — must not follow polling. If the write reached the server
 * and the response was lost, background polling shows a newer version long
 * before the user retries; re-deriving the payload would mint a second request
 * id and commit the round twice.
 *
 * `currentVersion` is the base version the server writes against: submitted
 * intents are an upsert keyed by scope, not an append, so an attempt written
 * against a version that has moved is rejected with a conflict rather than
 * silently replacing another client's intent. A conflict therefore *ends* this
 * attempt — the record is dropped, and the next try is written against the
 * version the user has just re-read, with an id of its own. Retrying an
 * attempt whose response was merely lost keeps both, because the server
 * resolves the request id before it looks at the version.
 *
 * The id is random per attempt, not derived from the text. Two submissions of
 * the same sentence are two submissions — de-duplication may only ever mean
 * "this exact attempt is being retried", never "someone said this before".
 * That also means exactly-once is scoped to this record: a reload starts a new
 * attempt, and nothing here claims otherwise.
 */
export interface PendingSubmit {
  /** Identity of this attempt: map, read cursor and the user's own message. */
  key: string;
  mapId: string;
  baseVersion: number;
  /** Version this attempt was written against. Never refreshed from a later read. */
  currentVersion: number;
  requestId: string;
  /** Set once the server accepted the write; a retry then only re-reads. */
  message?: string;
  /** The version the accepted message describes — not whatever the map is now. */
  version?: number;
}

export function beginSubmit(
  previous: PendingSubmit | undefined,
  input: { mapId: string; baseVersion: number; currentVersion: number; userMessage: string },
  mint: () => string,
): PendingSubmit {
  const key = JSON.stringify([input.mapId, input.baseVersion, input.userMessage]);
  // Same attempt still unresolved → keep its payload, id and result verbatim.
  if (previous?.key === key) return previous;
  return { key, mapId: input.mapId, baseVersion: input.baseVersion, currentVersion: input.currentVersion, requestId: mint() };
}

/**
 * Which of two same-map snapshots a queued write should go out against.
 *
 * `openMap.current` (main.tsx) is usually the fresher of the two — `mutate`
 * updates it synchronously as soon as a write's result is known, ahead of the
 * render that will eventually show the same value, which is what lets a
 * second queued write read a version the first one just produced. But the
 * assignment that mirrors a *pushed* update (a poll or websocket message) onto
 * `openMap.current` does not compare versions before overwriting it, so a
 * stale message can briefly leave it *behind* the rendered `snapshot` state,
 * until some unrelated render pulls it even again. Comparing versions rather
 * than trusting either side outright is what keeps a write from going out
 * against whichever one happens to be older. A different map id is not this
 * function's problem to resolve — the caller decides what that means.
 */
export function latestOf<T extends Versioned>(openMap: T | undefined, snapshot: T): T {
  return openMap && openMap.id === snapshot.id && openMap.version > snapshot.version ? openMap : snapshot;
}

/**
 * User-facing text for a write a conflict ultimately defeated.
 *
 * Never the raw "VERSION_CONFLICT · 请先读取 since=N…" the server states —
 * that sentence tells an Agent which summary to re-read, and means nothing to
 * a person watching a banner. The technical detail is not lost, only moved: it
 * survives on `ConflictError.cause`, for logs and devtools, not in `message`.
 */
export const CONFLICT_RETRY_MESSAGE = '有人刚改过这张图，已刷新到最新版本，请重新做一次这个操作。';
/** Shown when the replayed write is refused because what it targeted is gone. */
export const CONFLICT_TARGET_GONE_MESSAGE = '这个对象已经被别人删除或改动，地图已刷新。';

/** A conflict the adapter could not resolve on the caller's behalf. */
export class ConflictError extends Error {
  readonly code = 'conflict' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConflictError';
  }
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Whether `error` is the 409 the server states when `baseVersion` is stale. */
export function isVersionConflict(error: unknown): boolean {
  return statusOf(error) === 409;
}

/**
 * Retry a semantic edit exactly once, against the version a conflict just
 * proved was stale.
 *
 * A 409 means nothing was written, so replaying the very same operations
 * against a version the server has actually reached is safe — as long as the
 * replay mints its own request id (see `IdempotentRequest`): reusing the first
 * attempt's id would ask the server to deduplicate a request it never
 * committed against a body that may no longer match. One retry, not a loop —
 * a second conflict means edits are landing faster than this one call can
 * keep up with, and the person driving it deserves to be told rather than sit
 * behind a request silently repeating forever.
 *
 * Never used for a whole-map replace: replaying that against a version newer
 * than the one it was composed from would silently overwrite whatever the
 * conflicting write just did. See the `replace` methods, which refresh and
 * report instead of retrying.
 *
 * @param first The first attempt's base version and request id.
 * @param send Issue one attempt; must reject with `.status` set to the HTTP
 *   status the server actually stated (409, or a 4xx once the replayed
 *   operations no longer apply to the refreshed map) for this to work.
 * @param refreshVersion Re-read the map from the server and report its
 *   version; a failure here is not caught; it is not this helper's
 *   business to say the write failed when it does not know that.
 * @param mintRequestId A fresh, unused request id for the retry.
 */
export async function retryEditConflictOnce<T>(
  first: { baseVersion: number; requestId: string },
  send: (attempt: { baseVersion: number; requestId: string }) => Promise<T>,
  refreshVersion: () => Promise<number>,
  mintRequestId: () => string,
): Promise<T> {
  try {
    return await send(first);
  } catch (error) {
    if (!isVersionConflict(error)) throw error;
    const baseVersion = await refreshVersion();
    try {
      return await send({ baseVersion, requestId: mintRequestId() });
    } catch (retryError) {
      if (isVersionConflict(retryError)) throw new ConflictError(CONFLICT_RETRY_MESSAGE, { cause: retryError });
      const status = statusOf(retryError);
      // Any other 4xx from the replay means the fresh map no longer accepts
      // these operations as they were composed — a layer or point the edit
      // named is gone, most likely. A 5xx or a network failure is not that:
      // the outcome is unknown, so the original error is left to speak for it.
      if (status !== undefined && status >= 400 && status < 500) throw new ConflictError(CONFLICT_TARGET_GONE_MESSAGE, { cause: retryError });
      throw retryError;
    }
  }
}

/**
 * Report a conflict on a whole-map replace, without ever replaying it.
 *
 * `replace` sends the entire map as the caller composed it; replaying that
 * against a version newer than the one it started from would silently discard
 * whatever the conflicting write just did. So there is no second attempt here
 * — only the refresh a person needs before trying again by hand, and the
 * pending idempotent entry is cleared so that a genuinely new attempt (even
 * one with textually identical content) mints its own id rather than reusing
 * this one's.
 */
export async function reportReplaceConflict(error: unknown, refreshVersion: () => Promise<number>, clearPending: () => void): Promise<never> {
  if (!isVersionConflict(error)) throw error;
  clearPending();
  await refreshVersion();
  throw new ConflictError(CONFLICT_RETRY_MESSAGE, { cause: error });
}
