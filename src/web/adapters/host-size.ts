/**
 * Container size negotiation for MCP Apps hosts (spec 2026-01-26).
 *
 * Every declared dimension — `width`/`height` as much as `maxWidth`/`maxHeight`
 * — is read here as an upper bound. The spec distinguishes them (a fixed axis
 * is the host's to decide, an elastic one is the view's within the bound), and
 * on the fixed axis "the view fills it" is the usual reading. This code does
 * not take that reading on the height axis, for one reason: a host that fixes
 * the height at 1600px has decided how much room *it* has, and a card that
 * fills 1600px of it is one the reader has to scroll several screens past to
 * reach the rest of the conversation. Room offered is not room worth taking.
 *
 * So the extent on each axis is `min(target, every bound the host declared)`,
 * and `PREFERRED_WIDTH` / `PREFERRED_HEIGHT` are a ceiling as much as a goal.
 * The same formula lives in CSS (`--app-height` in `styles.css`), which is what
 * actually holds the layout down — `tests/e2e/embedding.spec.ts` asserts the two
 * agree, because the layout is the half that survives a host saying nothing.
 *
 * A view that renders smaller than the box the host fixed still says so. It is
 * not asking to override the host: it is reporting that it left room on the
 * table, which is the only way a host that sized the frame from a guess gets to
 * take that room back. What it cannot do is ask for *more* than a fixed axis —
 * there the answer is `ui/request-display-mode` (the expand button).
 *
 * `COMPACT_HEIGHT` is a layout threshold only: below it the UI switches to a
 * compact arrangement — it is never a floor for the request, because a request
 * above the host bound is out of spec.
 *
 * Pure module: no DOM, no SDK. `src/web/adapters/mcp.ts` applies the results.
 */

/**
 * Desktop target in CSS px: what an unbounded axis is asked for, and the most
 * a bounded one is ever asked for.
 *
 * `PREFERRED_HEIGHT` is also the view's intrinsic height ceiling, because the
 * hosts that embed this card lay their content out in a scrolling column: the
 * width they offer is the real estate they have, but the height they offer is
 * only how far they are willing to let one card push everything else down.
 * `styles.css` keeps `--app-max-height` in step with it, and
 * `tests/mcp-adapter.test.ts` asserts the two still agree.
 */
export const PREFERRED_WIDTH = 1280;
export const PREFERRED_HEIGHT = 720;
/** Below this available height the workspace switches to the compact layout. */
export const COMPACT_HEIGHT = 320;
/** Below this available width the workspace switches to the compact layout. */
export const COMPACT_WIDTH = 620;

export interface ContainerDimensions {
  width?: number;
  height?: number;
  maxWidth?: number;
  maxHeight?: number;
}

/** The subset of `McpUiHostContext` that drives layout. */
export interface HostSizeContext {
  displayMode?: string;
  containerDimensions?: ContainerDimensions;
}

export interface SizeRequest {
  width?: number;
  height?: number;
}

/**
 * Window event carrying each `SizeDeclaration` as it happens.
 *
 * Diagnostics only — `adapters/diagnostics.ts` is the sole listener and no
 * product behaviour depends on it. It lives here so the adapter can announce
 * without importing the read-out that is normally not in the bundle at all.
 */
export const SIZE_DECLARED_EVENT = 'cartula:size-declared';

/**
 * Result of one size declaration attempt. A failed send is deliberately not
 * remembered as declared, so the same request can be retried.
 */
export interface SizeDeclaration {
  status: 'sent' | 'unchanged' | 'skipped' | 'failed';
  request: SizeRequest | null;
  detail?: string;
}

/**
 * A dimension the host actually declared.
 *
 * The spec types these as plain numbers with no lower bound, so `0` is a
 * declared value — a real, if degenerate, constraint — and must not be read as
 * "no limit". Only non-numbers, NaN/Infinity and negatives (which no host can
 * mean literally) count as absent. Values are kept exact: rounding 239.6 up to
 * 240 would ask for more than the host allows.
 */
export function declaredSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface Axis {
  /** Extent the host fixed. An upper bound here, not an instruction to fill. */
  fixed?: number;
  /** Elastic upper bound the view has to stay within. */
  max?: number;
}

function axis(dims: ContainerDimensions | undefined, fixedKey: 'width' | 'height', maxKey: 'maxWidth' | 'maxHeight'): Axis {
  return { fixed: declaredSize(dims?.[fixedKey]), max: declaredSize(dims?.[maxKey]) };
}

/**
 * The extent the view will actually render on one axis: its own target, held
 * inside every bound the host declared, whichever kind they were.
 *
 * The mirror of `--app-height` in `styles.css`. Exact, decimals included — the
 * caller rounds, and only downwards, so a sub-pixel bound is never rounded up
 * past the limit.
 */
function axisExtent(target: number, { fixed, max }: Axis): number {
  return Math.min(target, fixed ?? target, max ?? target);
}

/**
 * What to report on one axis, in whole pixels, or `undefined` when there is
 * nothing to say.
 *
 * The number is always the extent the view renders. It is withheld in exactly
 * one case: the host fixed this axis and the view is filling it, so the host
 * would only be told the number it just sent. When the view renders *smaller*
 * than a fixed axis the report is the whole point — that is the host learning
 * it is holding room the card will not use.
 *
 * An axis that works out to less than a pixel is left out too: a zero-size
 * request tells a host nothing it can act on.
 */
function axisRequest(target: number, state: Axis): number | undefined {
  const wanted = Math.floor(axisExtent(target, state));
  if (wanted < 1) return undefined;
  return state.fixed !== undefined && wanted >= Math.floor(state.fixed) ? undefined : wanted;
}

/**
 * The size to report through `ui/notifications/size-changed`, or `null` when
 * there is nothing to say (fullscreen, or every axis already filled as fixed).
 */
export function resolveSizeRequest(
  ctx: HostSizeContext | undefined,
  preferredHeight = PREFERRED_HEIGHT,
  preferredWidth = PREFERRED_WIDTH
): SizeRequest | null {
  if (ctx?.displayMode === 'fullscreen') return null;
  const dims = ctx?.containerDimensions;
  const height = axisRequest(preferredHeight, axis(dims, 'height', 'maxHeight'));
  const width = axisRequest(preferredWidth, axis(dims, 'width', 'maxWidth'));
  if (height === undefined && width === undefined) return null;
  return { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) };
}

/**
 * The box the view will render, both axes, whether or not either is worth
 * reporting. Fullscreen has no such box — the host owns the whole surface.
 *
 * This is what the diagnostics overlay shows next to the numbers the host sent,
 * so a card in a real host can be read as "this is what it said, this is what I
 * worked out, this is what actually got laid out".
 */
export function renderedSize(ctx: HostSizeContext | undefined): SizeRequest | null {
  if (ctx?.displayMode === 'fullscreen') return null;
  const dims = ctx?.containerDimensions;
  return {
    width: Math.floor(axisExtent(PREFERRED_WIDTH, axis(dims, 'width', 'maxWidth'))),
    height: Math.floor(axisExtent(PREFERRED_HEIGHT, axis(dims, 'height', 'maxHeight'))),
  };
}

export interface HostLayout {
  /** CSS custom properties for the document root; `null` means "remove". */
  variables: Record<string, string | null>;
  /** Height the workspace can actually use, when the host bounded it. */
  availableHeight?: number;
  availableWidth?: number;
  /** Small container: collapse detail, keep the expand entry visible. */
  compact: boolean;
}

/**
 * Root layout for a host context. Fixed axes pin the root box to the host
 * value; elastic axes only cap it, so the view still fills the iframe the host
 * actually rendered. Fullscreen clears every constraint.
 */
export function hostLayout(ctx: HostSizeContext | undefined): HostLayout {
  const clear: Record<string, string | null> = {
    '--host-height': null,
    '--host-max-height': null,
    '--host-width': null,
    '--host-max-width': null,
  };
  if (!ctx || ctx.displayMode === 'fullscreen') return { variables: clear, compact: false };
  const dims = ctx.containerDimensions;
  const height = axis(dims, 'height', 'maxHeight');
  const width = axis(dims, 'width', 'maxWidth');
  // Exact values, decimals included: the box must not exceed what was declared.
  const variables: Record<string, string | null> = {
    '--host-height': height.fixed === undefined ? null : `${height.fixed}px`,
    '--host-max-height': height.max === undefined ? null : `${height.max}px`,
    '--host-width': width.fixed === undefined ? null : `${width.fixed}px`,
    '--host-max-width': width.max === undefined ? null : `${width.max}px`,
  };
  const availableHeight = height.fixed ?? height.max;
  const availableWidth = width.fixed ?? width.max;
  return {
    variables,
    ...(availableHeight === undefined ? {} : { availableHeight }),
    ...(availableWidth === undefined ? {} : { availableWidth }),
    compact: (availableHeight !== undefined && availableHeight < COMPACT_HEIGHT) || (availableWidth !== undefined && availableWidth < COMPACT_WIDTH),
  };
}

/** Two requests that describe the same box: the second one must not be sent. */
export function sameSizeRequest(a: SizeRequest | null, b: SizeRequest | null): boolean {
  if (!a || !b) return a === b;
  return a.width === b.width && a.height === b.height;
}
