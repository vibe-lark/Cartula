import type { LegLabelMode } from './legs.js';

export interface LabelNode {
  key: string; name: string; x: number; y: number; selected?: boolean; hovered?: boolean; endpoint?: boolean; dimmed?: boolean; emphasized?: boolean;
  /** Half-width of the marker around its anchor, in px; labels keep clear of it. */
  markerRadius?: number;
  /** How far the marker reaches above its anchor, in px — a pin's head, say — when that is more than `markerRadius`. */
  markerTop?: number;
}
export interface PlacedLabel { key: string; text: string; x: number; y: number; width: number; height: number; offset: [number, number] }
const charWidth = (char: string, font: number) => /[⺀-￿MW@#%&⚠]/u.test(char) ? font : font * 0.7;
function wrap(text: string, font: number, max: number) {
  const lines = ['']; let width = 0, widest = 0;
  for (const char of text) {
    const next = charWidth(char, font);
    if (width + next > max) { widest = Math.max(widest, width); lines.push(''); width = 0; }
    lines[lines.length - 1] += char; width += next;
  }
  return { text: lines.join('\n'), width: Math.max(widest, width) + 10, height: lines.length * font * 1.25 + 6 };
}

/** A leg annotation competing for screen space after the node labels. */
export interface LegLabelCandidate {
  key: string;
  text: string;
  /** Anchor in screen px (the projected leg midpoint). */
  ax: number; ay: number;
  /** Unit direction of the annotated segment in screen space. */
  dirX: number; dirY: number;
  /** On-screen segment length in px — the auto-mode density gate. */
  lengthPx: number;
  /** Belongs to the active layer: a lower gate and placement priority. */
  active?: boolean;
  /** Hovered/selected adjacency: bypasses the gate and (capped) the budget. */
  forced?: boolean;
}
export interface PlacedLegLabel {
  key: string; text: string;
  /** Pill CENTER in screen px — note PlacedLabel.y is a bottom edge instead. */
  x: number; y: number;
  width: number; height: number;
  /** Pill center relative to the anchor, for deck.gl getPixelOffset. */
  offset: [number, number];
}
export interface LayoutLegOptions {
  mode?: LegLabelMode;
  /**
   * Plan switch chips. Placed before everything else and never dropped: this
   * is the only way back to a plan the map is showing as a backdrop, and a
   * control that disappears when the map gets busy is not a control. They are
   * also not subject to the density mode — 隐藏路段标注 hides annotations, not
   * the way to the other plan.
   */
  chips?: LegLabelCandidate[];
}

const LEG_FONT = 11;
const LEG_HEIGHT = LEG_FONT * 1.25 + 6;
/** Auto-mode gates: a leg must be this long on screen to earn a pill. */
const LEG_GATE_PX = 70;
const LEG_GATE_ACTIVE_PX = 44;
/** A forced (hovered/selected) leg may exceed the budget by this many pills. */
const LEG_FORCED_EXTRA = 4;

function legBudget(mode: LegLabelMode, area: number): number {
  if (mode === 'all') return Math.max(3, Math.min(48, Math.floor(area / 24000)));
  return Math.max(3, Math.min(20, Math.floor(area / 48000)));
}

function measureLeg(text: string): { width: number; height: number } {
  let width = 12; // horizontal pill padding
  for (const char of text) width += charWidth(char, LEG_FONT);
  return { width, height: LEG_HEIGHT };
}

/**
 * Screen-space greedy placement with a spatial index, shared by node labels
 * and leg pills. Node labels place first — identity outranks annotation —
 * then leg pills are tucked perpendicular to their segments into whatever
 * space remains. All markers remain pickable; only labels compete for space.
 */
export function layoutAnnotations(
  nodes: LabelNode[],
  legs: LegLabelCandidate[],
  width: number,
  height: number,
  zoom: number,
  options: LayoutLegOptions = {},
): { labels: PlacedLabel[]; legs: PlacedLegLabel[]; chips: PlacedLegLabel[] } {
  if (width < 40 || height < 40) return { labels: [], legs: [], chips: [] };
  type Box = { left: number; right: number; top: number; bottom: number };
  const cells = new Map<string, Box[]>();
  function keys(box: Box) {
    const out: string[] = [];
    for (let x = Math.floor(box.left / 64); x <= Math.floor(box.right / 64); x++)
      for (let y = Math.floor(box.top / 64); y <= Math.floor(box.bottom / 64); y++) out.push(`${x},${y}`);
    return out;
  }
  function add(box: Box) { for (const key of keys(box)) { const values = cells.get(key) ?? []; values.push(box); cells.set(key, values); } }
  function collides(box: Box) { return keys(box).some(key => (cells.get(key) ?? []).some(b => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top)); }
  /**
   * Tuck one pill beside its anchor, alternating sides and moving outwards.
   * `insist` places it at the first candidate even when everything collides —
   * for a label that has to exist rather than one that has to fit.
   */
  function placePill(leg: LegLabelCandidate, distances: number[], insist: boolean): PlacedLegLabel | undefined {
    const { width: pillWidth, height: pillHeight } = measureLeg(leg.text);
    // Perpendicular to the annotated segment, so the line stays readable.
    const nx = -(leg.dirY || 0);
    const ny = leg.dirX || 0;
    let fallback: PlacedLegLabel | undefined;
    for (const distance of distances) {
      const x = Math.max(pillWidth / 2 + 4, Math.min(width - pillWidth / 2 - 4, leg.ax + nx * distance));
      const y = Math.max(pillHeight / 2 + 4, Math.min(height - pillHeight / 2 - 4, leg.ay + ny * distance));
      const box = { left: x - pillWidth / 2 - 2, right: x + pillWidth / 2 + 2, top: y - pillHeight / 2 - 2, bottom: y + pillHeight / 2 + 2 };
      const placed = { key: leg.key, text: leg.text, x, y, width: pillWidth, height: pillHeight, offset: [x - leg.ax, y - leg.ay] as [number, number] };
      if (!fallback) fallback = placed;
      if (collides(box)) continue;
      add(box);
      return placed;
    }
    if (!insist || !fallback) return undefined;
    add({ left: fallback.x - pillWidth / 2 - 2, right: fallback.x + pillWidth / 2 + 2, top: fallback.y - pillHeight / 2 - 2, bottom: fallback.y + pillHeight / 2 + 2 });
    return fallback;
  }

  /* Chips first — before the node labels, which is what makes them survive a
   * crowded map. Everything placed afterwards routes around them. */
  const chips: PlacedLegLabel[] = [];
  for (const chip of options.chips ?? []) {
    if (!Number.isFinite(chip.ax) || !Number.isFinite(chip.ay)) continue;
    if (chip.ax < 0 || chip.ax > width || chip.ay < 0 || chip.ay > height) continue;
    const placed = placePill(chip, [18, -18, 30, -30, 44, -44], true);
    if (placed) chips.push(placed);
  }

  const visible = nodes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y) && n.x >= 0 && n.x <= width && n.y >= 0 && n.y <= height);
  // Labels also avoid other destination markers.
  visible.forEach(n => { const r = n.markerRadius ?? 6; add({ left: n.x - r, right: n.x + r, top: n.y - Math.max(r, n.markerTop ?? 0), bottom: n.y + r }); });
  const priority = (n: LabelNode) => (n.selected ? 100 : 0) + (n.hovered ? 80 : 0) + (n.endpoint ? 20 : 0) - (n.dimmed ? 10 : 0);
  const ordered = [...visible].sort((a, b) => priority(b) - priority(a) || a.key.localeCompare(b.key));
  const budget = Math.max(6, Math.min(180, Math.floor(width * height / (zoom < 5 ? 24000 : zoom < 9 ? 14000 : 8000))));
  const labels: PlacedLabel[] = [];
  for (const node of ordered) {
    if (labels.length >= budget && !node.selected && !node.hovered) break;
    const font = node.selected || node.hovered ? 14 : node.emphasized ? 13 : 12;
    const label = wrap(node.name, font, Math.min(250, width - 30));
    // y is the label's bottom edge, matching the map and SVG text baseline.
    // Offsets grow with the marker: a 6px dot keeps the historical 18px lift,
    // a 24px numbered disc or a pin head pushes the label out past itself.
    const r = node.markerRadius ?? 6;
    const above = Math.max(r, node.markerTop ?? 0) + 12;
    const candidates: [number, number][] = [[0, -above], [0, label.height + r + 12], [label.width / 2 + r + 8, label.height / 2], [-label.width / 2 - r - 8, label.height / 2]];
    if (node.selected) candidates.push([0, -above - label.height], [0, label.height * 2 + r + 12], [label.width / 2 + r + 22, -above], [-label.width / 2 - r - 22, -above]);
    const tryPlace = (ignoreCollision: boolean) => {
      for (const [dx, dy] of candidates) {
        const x = Math.max(label.width / 2 + 8, Math.min(width - label.width / 2 - 8, node.x + dx));
        const y = Math.max(label.height + 8, Math.min(height - 8, node.y + dy));
        const box = { left: x - label.width / 2 - 3, right: x + label.width / 2 + 3, top: y - label.height - 3, bottom: y + 3 };
        if (box.left < 4 || box.right > width - 4 || box.top < 4 || box.bottom > height - 4) continue;
        if (!ignoreCollision && collides(box)) continue;
        add(box); labels.push({ key: node.key, ...label, x, y, offset: [x - node.x, y - node.y] }); return true;
      }
      return false;
    };
    // Selected labels outrank density: if every offset collides with other
    // markers, still place one so the user can see what they just picked.
    if (!tryPlace(false) && node.selected) tryPlace(true);
  }

  /* ------------------------------------------------------------ leg pills */
  const mode = options.mode ?? 'auto';
  const placedLegs: PlacedLegLabel[] = [];
  if (mode !== 'off') {
    const gate = (leg: LegLabelCandidate) => leg.forced || mode === 'all' || leg.lengthPx >= (leg.active ? LEG_GATE_ACTIVE_PX : LEG_GATE_PX);
    const candidates = legs
      .filter(leg => Number.isFinite(leg.ax) && Number.isFinite(leg.ay) && leg.ax >= 0 && leg.ax <= width && leg.ay >= 0 && leg.ay <= height && gate(leg))
      .sort((a, b) => Number(b.forced ?? false) - Number(a.forced ?? false) || Number(b.active ?? false) - Number(a.active ?? false) || b.lengthPx - a.lengthPx || a.key.localeCompare(b.key));
    const quota = legBudget(mode, width * height);
    for (const leg of candidates) {
      if (placedLegs.length >= quota && !leg.forced) break;
      if (placedLegs.length >= quota + LEG_FORCED_EXTRA) break;
      const placed = placePill(leg, [14, -14, 24, -24], false);
      if (placed) placedLegs.push(placed);
    }
  }
  return { labels, legs: placedLegs, chips };
}

/** Screen-space greedy placement with a spatial index. All markers remain
 * pickable; only labels compete for space. Priority and density vary with the
 * viewport, so overlapping destinations are revealed as the user zooms in. */
export function layoutLabels(nodes: LabelNode[], width: number, height: number, zoom: number): PlacedLabel[] {
  return layoutAnnotations(nodes, [], width, height, zoom).labels;
}
