import type { EditOperation, MapInput, MapSnapshot, Suggestion } from '../../core/types.js';
import type { PlanningDelivery } from './delivery.js';
import type { AccessPort } from './access.js';
export type Connection = 'live' | 'polling' | 'offline' | 'connecting';
export interface AdapterUpdate {
  /** Host teardown: unmount the canvas and its workers while the bridge acknowledges. */
  closed?: true;
  snapshot?: MapSnapshot;
  connection?: Connection;
  error?: string;
  suggestion?: Suggestion;
  /**
   * The open map may no longer be shown, and the reason is not a failed read.
   *
   * Losing permission and failing to refresh look the same from a status code
   * and are not the same thing: signing out of a private map takes away the
   * right to the copy already on screen, and leaving that rendered behind an
   * error message keeps showing a map this browser can no longer read. Only a
   * credential this side *knows* has stopped applying sets this — a preview
   * that is still valid, or an unclaimed key that still opens the map, is
   * untouched by signing out and must not clear anything.
   *
   * `'access-revoked'` rather than a bare boolean or a bare `undefined`
   * snapshot: the shell has to tell "this map is gone" apart from "no map has
   * arrived yet", which is what an absent snapshot already means.
   */
  cleared?: 'access-revoked';
}
/**
 * What a display-mode request actually produced. `granted` is the only state
 * that proves the host switched; `denied` means the host answered with another
 * mode, `unsupported` that it never offered the mode, `error` that the request
 * itself failed. Browser fullscreen is a separate mechanism and never proves
 * any of these.
 */
export interface DisplayModeOutcome {
  mode: 'inline' | 'fullscreen' | 'pip';
  status: 'granted' | 'denied' | 'unsupported' | 'error';
  detail?: string;
}

/**
 * Window event carrying one whole attempt at going fullscreen, both mechanisms.
 *
 * Diagnostics only — `adapters/diagnostics.ts` is the sole listener and nothing
 * depends on it being heard. It exists because "the button does nothing" has
 * several very different causes (the host never offered the mode, the host
 * answered `granted` and then did nothing, the Fullscreen API is not permitted
 * in the frame) and from outside they look identical.
 */
export const DISPLAY_MODE_EVENT = 'cartula:display-mode';
export interface DisplayModeAttempt {
  requested: DisplayModeOutcome['mode'];
  /** Absent when the adapter has no host to ask — the standalone page. */
  outcome?: DisplayModeOutcome;
  /** Whether the browser Fullscreen API fallback actually entered fullscreen. */
  browserFullscreen?: boolean;
}
/**
 * What a hand-off actually handed over.
 *
 * The message describes the map as of `version`. The snapshot may already be
 * newer — another client can write between the submit and the read-back — so
 * the two are kept apart: the view follows `snapshot`, while "already handed
 * over" cursors, copies and resends follow `version`, which never claims
 * changes the message does not contain.
 */
export interface HandoffResult {
  mapId: string;
  version: number;
  message: string;
  snapshot: MapSnapshot;
}
export interface Adapter {
  editable: boolean;
  mode: 'browser' | 'mcp' | 'offline';
  initialize: (onUpdate: (update: AdapterUpdate) => void) => Promise<MapSnapshot>;
  edit: (snapshot: MapSnapshot, operations: EditOperation[]) => Promise<MapSnapshot>;
  replace: (input: MapInput, snapshot: MapSnapshot) => Promise<MapSnapshot>;
  export: (snapshot: MapSnapshot, format: 'json' | 'html') => Promise<void>;
  dispose: () => void;
  /** Only MCP Apps can send a user-initiated message into their host. */
  sendPlanningMessage?: (text: string) => Promise<PlanningDelivery>;
  submitChanges?: (snapshot: MapSnapshot, input: { since: number; userMessage?: string }) => Promise<HandoffResult>;
  /**
   * Tell the server this round reached the conversation.
   *
   * Only the view knows that — the host accepted `ui/message`, or the user
   * copied the message — and only the server can give the boundary back after a
   * reload the frame has no storage to survive. Absent where it cannot work: a
   * read-only or offline map has nothing to record against.
   */
  recordHandoff?: (mapId: string, version: number) => Promise<void>;
  /**
   * The share token this view is holding, when it is holding one at all.
   *
   * Only a fallback hand-off message needs this: the primary path is the
   * server's own `submit_changes` / `/submit` response, which already knows
   * whether the caller authenticated with a preview token and folds it into
   * the message itself. `canWrite` mirrors the confirmed grant, not a guess
   * from the token's shape — an owner holding no token returns `undefined`,
   * never a space key or API key dressed up as one.
   */
  shareCredential?: () => { previewToken: string; canWrite: boolean } | undefined;
  unlock?: (credential: string) => Promise<void>;
  fork?: (snapshot: MapSnapshot) => Promise<MapSnapshot>;
  requestDisplayMode?: (mode: 'inline' | 'fullscreen' | 'pip') => Promise<DisplayModeOutcome>;
  /**
   * Display modes the *host* says it can grant, or `undefined` when it has not
   * said. Not the same as the list the App declares it supports — that one is
   * about this view's abilities and is always the same.
   *
   * Read before offering the entry, not after the user presses it. A host that
   * never offered fullscreen answers a request with `unsupported`, which is
   * only useful if someone has already clicked something that then does
   * nothing. `undefined` is not a refusal: nothing has been ruled out, and
   * asking is how it gets settled.
   */
  availableDisplayModes?: () => readonly string[] | undefined;
  /**
   * Accounts, spaces and shares. Absent where none of it can work — an offline
   * copy has no server to ask — and the header then shows no such entries at
   * all rather than buttons that cannot do anything.
   */
  readonly access?: AccessPort;
  readonly editUrl?: string;
}
export function download(content: string, filename: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
