import { ICON_WARN_COLOR, POINT_ICONS, iconFill } from '../../core/icons.js';
import type { PointIcon } from '../../core/types.js';
import { drawPoiPictogram } from './poiIcons.js';

/**
 * The pin atlas: one teardrop per icon and theme, drawn once into a canvas
 * that deck.gl samples as a texture.
 *
 * A pin is the mark for a place an Agent or a user put on the map, and it has
 * to read as such against the basemap's own POI dots at every zoom. So it is
 * bigger than they are — a 24px head on a 60px cell — and it sits in a soft
 * halo of its own colour, the same device the numbered route discs use. The
 * halo is part of the texture rather than a second layer so that the two can
 * never drift apart under a drag.
 *
 * Geometry, in atlas pixels: the cell is `CELL` square, the tip is anchored
 * `TIP_INSET` above the bottom edge, the head's centre is `TIP_DROP` above the
 * tip, and the head's radius is `HEAD_R`. Everything scales together with the
 * on-screen size the IconLayer asks for, so `pinExtent` can say how much of
 * the screen a pin covers from that size alone.
 */
export const CELL = 112;
const SCALE = 2;
const HEAD_R = 11 * SCALE;
const TIP_DROP = 22 * SCALE;
const HALO_R = Math.round(HEAD_R * 1.5);
const TIP_INSET = 4;
const TIP_Y = CELL - TIP_INSET;
const HEAD_Y = TIP_Y - TIP_DROP;
const COLS = POINT_ICONS.length;
const ROWS = 3;

/** On-screen cell height of an ordinary pin: a 24px head, 37px from tip to crown. */
export const PIN_SIZE = 60;

/** How far a pin drawn at `size` px reaches above and beside its anchor. */
export function pinExtent(size: number): { top: number; halfWidth: number } {
  const k = size / CELL;
  return { top: Math.round((TIP_DROP + HALO_R) * k), halfWidth: Math.round(HALO_R * k) };
}

let atlas: HTMLCanvasElement | undefined;

type IconFrame = { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number; mask: false };

function frame(col: number, row: number): IconFrame {
  return { x: col * CELL, y: row * CELL, width: CELL, height: CELL, anchorX: CELL / 2, anchorY: TIP_Y, mask: false };
}

export const PIN_ICON_MAPPING: Record<string, IconFrame> = Object.fromEntries(
  POINT_ICONS.flatMap((icon, col) => [
    [`${icon}-light`, frame(col, 0)],
    [`${icon}-dark`, frame(col, 1)],
    [`${icon}-warn`, frame(col, 2)],
  ]),
);

function drawPin(ctx: CanvasRenderingContext2D, cx: number, tipY: number, scale: number) {
  const headY = tipY - 22 * scale;
  const r = 11 * scale;
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.bezierCurveTo(cx - 2 * scale, tipY - 8 * scale, cx - r, headY + r * 0.35, cx - r, headY);
  ctx.arc(cx, headY, r, Math.PI, 0, false);
  ctx.bezierCurveTo(cx + r, headY + r * 0.35, cx + 2 * scale, tipY - 8 * scale, cx, tipY);
  ctx.closePath();
}

function paintPin(ctx: CanvasRenderingContext2D, icon: PointIcon, fill: string, ox: number, oy: number) {
  const cx = ox + CELL / 2;
  const tipY = oy + TIP_Y;
  const headY = oy + HEAD_Y;
  ctx.save();
  // The halo: the pin's own colour, faint, around the head.
  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.arc(cx, headY, HALO_R, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.shadowColor = 'rgba(22, 33, 31, 0.3)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;
  drawPin(ctx, cx, tipY, SCALE);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  drawPoiPictogram(ctx, icon, cx, headY, 26);
  ctx.restore();
}

export function pinIconAtlas(): HTMLCanvasElement {
  if (atlas) return atlas;
  const canvas = document.createElement('canvas');
  canvas.width = COLS * CELL;
  canvas.height = ROWS * CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Cannot draw the map marker atlas');
  POINT_ICONS.forEach((icon, col) => {
    paintPin(ctx, icon, iconFill(icon, 'light'), col * CELL, 0);
    paintPin(ctx, icon, iconFill(icon, 'dark'), col * CELL, CELL);
    paintPin(ctx, icon, ICON_WARN_COLOR, col * CELL, CELL * 2);
  });
  atlas = canvas;
  return atlas;
}

/** SVG pin with the tip at (0, 0), head above. */
export function pinSvgPath(scale = 1): string {
  const r = 11 * scale;
  const headY = -22 * scale;
  return `M 0 0 C ${-2 * scale} ${-8 * scale} ${-r} ${headY + r * 0.35} ${-r} ${headY} A ${r} ${r} 0 1 1 ${r} ${headY} C ${r} ${headY + r * 0.35} ${2 * scale} ${-8 * scale} 0 0 Z`;
}
