import type { Intent, IntentPriority } from '../../core/types.js';

/**
 * Planning intents in the user's language.
 *
 * `must` / `prefer` / `avoid` / `optional` are protocol values that belong in
 * the payload, not on the canvas: a traveller should not have to learn the
 * enum to read their own map.
 */
export const PRIORITY_LABELS: Record<IntentPriority, string> = {
  must: '必须做到',
  prefer: '尽量做到',
  avoid: '尽量避免',
  optional: '可选',
};

export function priorityLabel(priority?: IntentPriority): string {
  return PRIORITY_LABELS[priority ?? 'prefer'];
}

/** Map-scope intents still waiting for the agent, newest last. */
export function activeMapIntents(intents: Intent[] | undefined): Intent[] {
  return (intents ?? []).filter(intent => intent.scope === 'map' && intent.status !== 'resolved');
}
