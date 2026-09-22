import type { MapSnapshot, SemanticEvent } from '../core/types.js';
export { planningMessage, agentAdjustmentText, type PlanningMessageOptions } from '../core/handoff.js';

/**
 * Change lines every agent write carries, whether or not anything happened
 * worth saying. The server prepends one of these to each of its own versions
 * (`src/server/store.ts`), so on their own they mean "a write happened" — which
 * the version number already says. Real notes travel behind them.
 */
const BOILERPLATE_CHANGES = new Set(['Agent 创建了地图', 'Agent 更新了地图方案', 'Agent 更新了地图']);

/**
 * The agent's explanation for its latest version, or nothing.
 *
 * A card that opens by itself over the map has to say something the person
 * looking at the map does not already know. An authored `reason` always does —
 * it is the agent saying why it made this change, which is exactly what the
 * hand-off asks it for. The fallback, a restatement of the change log, usually
 * does not: every map's first version carries "Agent 创建了地图", which tells
 * whoever just watched the map appear nothing at all.
 *
 * So the boilerplate is dropped and the card appears only if something specific
 * survives — a geometry note, or the semantic lines a `patch_map` produces.
 * Returning `null` is a real answer: it means there is nothing to pop open for,
 * and whatever the write did change is still one click away under 最近修改.
 */
export function agentNote(event: Pick<SemanticEvent, 'version' | 'changes' | 'reason'> | undefined): string | null {
  if (!event) return null;
  const reason = event.reason?.trim();
  if (reason) return `v${event.version} · ${reason}`;
  const notes = event.changes.filter(change => change && !BOILERPLATE_CHANGES.has(change));
  if (!notes.length) return null;
  const shown = notes.slice(0, 8).join('；');
  return `v${event.version} · ${shown}${notes.length > 8 ? '…' : ''}`;
}

/**
 * This round's user-authored changes — exactly what "继续规划" hands over, so
 * the dialog can state the scope of the submission instead of showing the
 * map's whole change log.
 *
 * `until` bounds the window at the version the hand-off message describes. A
 * snapshot refreshed after the submit can already contain someone else's newer
 * edits, and those were not handed over.
 */
export function roundSummary(map: MapSnapshot, since = 0, until = Number.POSITIVE_INFINITY): string[] {
  return map.events
    .filter(event => event.actor === 'user' && event.version > since && event.version <= until)
    .flatMap(event => event.changes)
    .filter(Boolean);
}
