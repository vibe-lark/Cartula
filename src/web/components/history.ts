import type { EditOperation, Intent, IntentScope, MapLayer, MapSnapshot, PointInput, RouteLeg, RouteLegPatch } from '../../core/types.js';

function intentKey(scope: IntentScope, layerId?: string, pointId?: string) {
  return `${scope}:${layerId ?? ''}:${pointId ?? ''}`;
}

function previousIntent(snapshot: MapSnapshot, scope: IntentScope, layerId?: string, pointId?: string): Pick<Intent, 'text' | 'priority' | 'status'> {
  const listed = snapshot.intents?.find(item => intentKey(item.scope, item.layerId, item.pointId) === intentKey(scope, layerId, pointId));
  if (listed) return { text: listed.text, ...(listed.priority ? { priority: listed.priority } : {}), ...(listed.status ? { status: listed.status } : {}) };
  if (scope === 'point' && layerId && pointId) {
    const layer = snapshot.layers.find(item => item.id === layerId);
    return { text: layer?.points.find(item => item.id === pointId)?.intent ?? '' };
  }
  if (scope === 'layer' && layerId) return { text: snapshot.layers.find(item => item.id === layerId)?.intent ?? '' };
  return { text: '' };
}

function inverseIntent(snapshot: MapSnapshot, scope: IntentScope, layerId?: string, pointId?: string): EditOperation {
  const previous = previousIntent(snapshot, scope, layerId, pointId);
  return {
    op: 'intent.set', scope, text: previous.text,
    ...(layerId ? { layerId } : {}),
    ...(pointId ? { pointId } : {}),
    ...(previous.priority ? { priority: previous.priority } : {}),
    ...(previous.status ? { status: previous.status } : {}),
  };
}

const LEG_PATCH_KEYS = ['distanceKm', 'durationMinutes', 'delayMinutes', 'profile', 'source', 'traffic', 'updatedAt', 'legId', 'path', 'border', 'toll', 'tunnel', 'closed', 'note'] as const;

function inverseLegPatch(leg: RouteLeg | undefined, patch: RouteLegPatch): RouteLegPatch {
  const inverse: RouteLegPatch = {};
  for (const key of LEG_PATCH_KEYS) {
    if (patch[key] === undefined) continue;
    const current = leg?.[key];
    (inverse as Record<string, unknown>)[key] = current === undefined ? null : structuredClone(current);
  }
  return inverse;
}

function pointInput(layer: MapLayer, pointId: string): PointInput {
  const point = layer.points.find(item => item.id === pointId)!;
  const copy: PointInput = { id: point.id, name: point.name, at: [point.at[0], point.at[1]] };
  if (point.day !== undefined) copy.day = point.day;
  if (point.note !== undefined) copy.note = point.note;
  if (point.intent !== undefined) copy.intent = point.intent;
  if (point.flexibility !== undefined) copy.flexibility = point.flexibility;
  if (point.warn === true) copy.warn = true;
  if (point.img !== undefined) copy.img = point.img;
  return copy;
}

/** Inverse of a user batch, applied in reverse order so undo restores the previous snapshot. */
export function invertOperations(snapshot: MapSnapshot, operations: EditOperation[]): EditOperation[] {
  const inverse: EditOperation[] = [];
  for (const operation of operations) {
    switch (operation.op) {
      case 'insert':
      case 'point.insert':
        inverse.push({ op: 'delete', layerId: operation.layerId, pointId: operation.point.id ?? '' });
        break;
      case 'delete':
      case 'point.delete': {
        const layer = snapshot.layers.find(item => item.id === operation.layerId);
        const index = layer?.points.findIndex(item => item.id === operation.pointId) ?? -1;
        if (!layer || index < 0) break;
        inverse.push({
          op: 'insert',
          layerId: layer.id,
          point: pointInput(layer, operation.pointId),
          ...(index > 0 ? { after: layer.points[index - 1].id } : {}),
        });
        break;
      }
      case 'update':
      case 'point.update': {
        const layer = snapshot.layers.find(item => item.id === operation.layerId);
        const point = layer?.points.find(item => item.id === operation.pointId);
        if (!layer || !point) break;
        inverse.push({
          op: 'update', layerId: layer.id, pointId: point.id,
          patch: {
            name: point.name, at: point.at, note: point.note ?? '', intent: point.intent ?? '',
            day: point.day ?? null, flexibility: point.flexibility ?? null,
            warn: point.warn === true, img: point.img ?? '',
          },
        });
        break;
      }
      case 'annotate': {
        const layer = snapshot.layers.find(item => item.id === operation.layerId);
        const point = layer?.points.find(item => item.id === operation.pointId);
        if (!layer || !point) break;
        inverse.push({ op: 'annotate', layerId: layer.id, pointId: point.id, text: point.note ?? '' });
        break;
      }
      case 'reorder':
      case 'point.reorder': {
        const layer = snapshot.layers.find(item => item.id === operation.layerId);
        const index = layer?.points.findIndex(item => item.id === operation.pointId) ?? -1;
        if (!layer || index < 0) break;
        inverse.push({ op: 'reorder', layerId: layer.id, pointId: operation.pointId, toIndex: index });
        break;
      }
      case 'layer.add':
        if (operation.layer.id) inverse.push({ op: 'layer.delete', layerId: operation.layer.id });
        break;
      case 'layer.delete': {
        const layer = snapshot.layers.find(item => item.id === operation.layerId);
        if (layer) inverse.push({ op: 'layer.add', layer: { ...layer, points: layer.points.map(point => pointInput(layer, point.id)) } });
        break;
      }
      case 'layer.update': {
        const layer = snapshot.layers.find(item => item.id === operation.layerId);
        if (!layer) break;
        inverse.push({
          op: 'layer.update', layerId: layer.id,
          patch: {
            name: layer.name, kind: layer.kind, color: layer.color, visible: layer.visible,
            from: layer.from ?? '', note: layer.note ?? '', intent: layer.intent ?? '',
            path: layer.path ?? null, routing: layer.routing ?? null,
          },
        });
        break;
      }
      case 'intent':
        inverse.push(inverseIntent(snapshot, 'map'));
        break;
      case 'intent.set':
        inverse.push(inverseIntent(snapshot, operation.scope, operation.layerId, operation.pointId));
        break;
      case 'route.leg.update': {
        const layer = snapshot.layers.find(item => item.id === operation.layerId);
        const leg = layer?.routing?.legs?.find(part => part.fromPointId === operation.fromPointId && part.toPointId === operation.toPointId);
        inverse.push({ op: 'route.leg.update', layerId: operation.layerId, fromPointId: operation.fromPointId, toPointId: operation.toPointId, patch: inverseLegPatch(leg, operation.patch) });
        break;
      }
      case 'draft.commit':
        break;
      default:
        break;
    }
  }
  return inverse.reverse().filter(operation => operation.op !== 'delete' || operation.pointId);
}
