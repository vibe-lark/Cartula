/**
 * Input validation for the two write paths: a whole-map `PUT` payload
 * (`MapInputSchema`) and a single semantic edit (`EditOperationSchema`).
 *
 * The two paths deliberately differ on unknown keys:
 *
 *  - `MapInputSchema` strips them. A client may PUT back a snapshot it received
 *    from `GET` (which carries `version`, `stats`, `events`, `routingStatus`, …),
 *    and that round trip has to keep working.
 *  - `EditOperationSchema` rejects them. An edit names one field to change, so
 *    an unknown key is a mistake about the contract, and silently dropping it
 *    would report success for work that never happened.
 *
 * Only `layer.name`, `point.name` and `point.at` are business requirements;
 * empty `layers` and empty `points` are valid maps.
 *
 * Pure zod, no I/O — safe in the browser, the server and the offline bundle.
 * The whole-map coordinate budgets live in `geometry.ts`, because they depend
 * on which geometry the caller actually wrote (see `censusCoords`).
 */
import { z } from 'zod';
import type { EditOperation, Intent, MapInput } from './types.js';
import { POINT_ICONS } from './icons.js';

/** Shared size/length budgets, exported so callers can document their API. */
export const LIMITS = {
  layers: 50,
  pointsPerLayer: 1000,
  /** Caller-written coordinates in one map: stops + geojson + supplied/rewritten road geometry. */
  coordsPerMap: 20_000,
  /**
   * Road geometry Cartula holds itself (resolved, or returned unchanged).
   * Simplified to fit, never rejected. Counted once per layer: the whole line
   * and its per-leg copies are the same polyline stored for two consumers.
   */
  derivedCoordsPerMap: 12_000,
  pathCoords: 20_000,
  featuresPerLayer: 2_000,
  operations: 200,
  title: 120,
  name: 80,
  note: 1_000,
  layerNote: 2_000,
  from: 500,
  img: 2_048,
  id: 64,
  day: 3_650,
} as const;

const NUMBER_REQUIRED = '坐标必须是数字';
const LON_RANGE = '经度必须在 -180 到 180 之间';
const LAT_RANGE = '纬度必须在 -90 到 90 之间';

const lonSchema = z.number(NUMBER_REQUIRED).min(-180, LON_RANGE).max(180, LON_RANGE);
const latSchema = z.number(NUMBER_REQUIRED).min(-90, LAT_RANGE).max(90, LAT_RANGE);

/**
 * A `[longitude, latitude]` pair. GeoJSON allows a third (altitude) element and
 * some exporters add more; extras are accepted and dropped rather than
 * rejected, because Cartula is a 2D canvas.
 */
export const CoordSchema = z
  .tuple([lonSchema, latSchema], z.number(NUMBER_REQUIRED))
  .transform((value): [number, number] => [value[0], value[1]]);

/** No whitespace and no C0/C7 control characters: ids travel in URLs and logs. */
const ID_RE = /^[^\s\u0000-\u001f\u007f]+$/u;

const idSchema = z
  .string('id 必须是字符串')
  .trim()
  .min(1, 'id 不能为空')
  .max(LIMITS.id, `id 最长 ${LIMITS.id} 个字符`)
  .regex(ID_RE, 'id 不能包含空白或控制字符');

const colorSchema = z
  .string('color 必须是字符串')
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'color 必须是 #RRGGBB 形式的十六进制颜色')
  .transform((value) => value.toLowerCase());

const HTTPS_ONLY = '链接必须使用 https://';

/**
 * Bounded free text. Plain prose, never URL-checked: notes and provenance
 * sentences legitimately contain colons — `Warning: low fuel`, `source: demo` —
 * so treating a colon as a URI scheme would reject ordinary writing. Consumers
 * render these as text, never as an `href`; `img` is the only URL field.
 */
const boundedText = (max: number, label: string) =>
  z.string(`${label} 必须是字符串`).trim().max(max, `${label} 最长 ${max} 个字符`);

/** Image source: an https URL, or empty string to mean "no image". */
const imgSchema = z
  .string('img 必须是字符串')
  .trim()
  .max(LIMITS.img, `img 最长 ${LIMITS.img} 个字符`)
  .refine((value) => value === '' || /^https:\/\/\S/.test(value), {
    message: `img ${HTTPS_ONLY}`,
  });

export const PointInputSchema = z.object({
  id: idSchema.optional(),
  name: z
    .string('point.name 必须是字符串')
    .trim()
    .min(1, '每个点都必须有 name')
    .max(LIMITS.name, `name 最长 ${LIMITS.name} 个字符`),
  at: CoordSchema,
  day: z
    .number('day 必须是数字')
    .int('day 必须是整数')
    .min(1, 'day 从 1 开始')
    .max(LIMITS.day, `day 最大 ${LIMITS.day}`)
    .optional()
    .describe('这个停靠点属于行程第几天，从 1 开始。多天行程请每个点都写：地图按方案给色系、按天分深浅，没有 day 的点只能和别人同色。'),
  note: boundedText(LIMITS.note, 'note').optional(),
  warn: z.boolean('warn 必须是布尔值').optional(),
  img: imgSchema.optional(),
  intent: boundedText(LIMITS.note, 'intent').optional(),
  flexibility: z.enum(['fixed', 'flexible']).optional(),
  icon: z.enum(POINT_ICONS, "icon 只能是 pin / hotel / restaurant / cafe / viewpoint / museum / park / parking / fuel / airport / station / camp / shop / hospital / note").optional(),
});

// --- GeoJSON --------------------------------------------------------------

const isClosedRing = (ring: [number, number][]): boolean => {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return !!first && !!last && first[0] === last[0] && first[1] === last[1];
};

const lineCoords = z.array(CoordSchema).min(2, 'LineString 至少需要 2 个坐标');

const linearRing = z
  .array(CoordSchema)
  .min(4, 'Polygon 的每个环至少需要 4 个坐标')
  .refine(isClosedRing, { message: 'Polygon 的环必须闭合（首尾坐标相同）' });

export const GeometrySchema = z.discriminatedUnion(
  'type',
  [
    z.object({ type: z.literal('Point'), coordinates: CoordSchema }),
    z.object({ type: z.literal('MultiPoint'), coordinates: z.array(CoordSchema) }),
    z.object({ type: z.literal('LineString'), coordinates: lineCoords }),
    z.object({ type: z.literal('MultiLineString'), coordinates: z.array(lineCoords).min(1) }),
    z.object({ type: z.literal('Polygon'), coordinates: z.array(linearRing).min(1, 'Polygon 至少需要 1 个环') }),
    z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(linearRing).min(1)).min(1) }),
  ],
  { error: 'geometry.type 必须是 Point/MultiPoint/LineString/MultiLineString/Polygon/MultiPolygon 之一' },
);

export const FeatureSchema = z.object({
  type: z.literal('Feature', "feature.type 必须是 'Feature'"),
  geometry: GeometrySchema,
  properties: z.record(z.string(), z.unknown()).nullable().default(null),
  id: z.union([idSchema, z.number()]).optional(),
});

export const FeatureCollectionSchema = z.object({
  type: z.literal('FeatureCollection', "geojson.type 必须是 'FeatureCollection'"),
  features: z
    .array(FeatureSchema)
    .max(LIMITS.featuresPerLayer, `单个图层最多 ${LIMITS.featuresPerLayer} 个 feature`),
});

// --- Layers ---------------------------------------------------------------

const kindSchema = z.enum(['route', 'spots', 'geojson'], "kind 只能是 'route' / 'spots' / 'geojson'");

const routingMetrics = {
  distanceKm: z.number().nonnegative().max(10_000_000).optional(),
  durationMinutes: z.number().nonnegative().max(5_256_000).optional(),
  delayMinutes: z.number().nonnegative().max(5_256_000).optional(),
};
const trafficSchema = z.enum(['unknown', 'clear', 'moderate', 'heavy', 'closed'], "traffic 只能是 unknown / clear / moderate / heavy / closed");
const isoTimeSchema = z.string().trim().max(40).optional();
export const RouteLegSchema = z.object({
  fromPointId: idSchema,
  toPointId: idSchema,
  profile: boundedText(80, 'routing.legs.profile').optional(),
  ...routingMetrics,
  legId: idSchema.optional(),
  source: boundedText(200, 'routing.legs.source').optional(),
  traffic: trafficSchema.optional(),
  updatedAt: isoTimeSchema,
  path: z.array(CoordSchema).max(LIMITS.pathCoords).optional(),
  border: z.boolean().optional(),
  toll: z.boolean().optional(),
  tunnel: z.boolean().optional(),
  closed: z.boolean().optional(),
  note: boundedText(LIMITS.note, 'routing.legs.note').optional(),
  color: colorSchema.optional(),
});
export const RoutingInputSchema = z.object({
  source: boundedText(200, 'routing.source').min(1),
  profile: boundedText(80, 'routing.profile').optional(),
  ...routingMetrics,
  updatedAt: isoTimeSchema,
  legs: z.array(RouteLegSchema).max(999).optional(),
});

/** Closed like the edit operations: an intent with a misspelt `priority` is a
 * mistake to report, and a snapshot's own intents carry no extra members. */
export const IntentSchema = z.strictObject({
  scope: z.enum(['map', 'layer', 'point'], "intent.scope 只能是 map / layer / point"),
  layerId: idSchema.optional(),
  pointId: idSchema.optional(),
  text: boundedText(LIMITS.layerNote, 'intent').min(1),
  priority: z.enum(['must', 'prefer', 'avoid', 'optional']).optional(),
  status: z.enum(['active', 'resolved']).optional(),
  author: z.enum(['agent', 'user']).optional(),
}, 'intent 只支持 scope / layerId / pointId / text / priority / status / author');

const layerShape = {
  id: idSchema.optional(),
  name: z
    .string('layer.name 必须是字符串')
    .trim()
    .min(1, '每个图层都必须有 name')
    .max(LIMITS.name, `name 最长 ${LIMITS.name} 个字符`),
  points: z
    .array(PointInputSchema)
    .max(LIMITS.pointsPerLayer, `单个图层最多 ${LIMITS.pointsPerLayer} 个点`)
    .optional(),
  kind: kindSchema.optional(),
  color: colorSchema.optional(),
  visible: z.boolean('visible 必须是布尔值').optional(),
  from: boundedText(LIMITS.from, 'from').optional(),
  note: boundedText(LIMITS.layerNote, 'note').optional(),
  crs: z.enum(['wgs84', 'gcj02'], "crs 只能是 'wgs84' 或 'gcj02'").optional(),
  geojson: FeatureCollectionSchema.optional(),
  /** Road geometry supplied by the caller; Cartula never infers it. */
  path: z.array(CoordSchema).max(LIMITS.pathCoords, `path 最多 ${LIMITS.pathCoords} 个坐标`).optional(),
  routing: RoutingInputSchema.optional(),
  intent: boundedText(LIMITS.layerNote, 'intent').optional(),
} as const;

export const LayerInputSchema = z.object(layerShape);

// --- Map input ------------------------------------------------------------

/**
 * A whole-map write payload. Unknown keys (`version`, `stats`, `events`, …) are
 * stripped so a snapshot can be PUT back unchanged.
 *
 * Duplicate ids are caught here; the map-wide coordinate budget is not, because
 * it depends on which geometry this write actually supplies — `normalizeMap`
 * and `applyOperations` enforce it once they know that.
 */
export const MapInputSchema = z
  .object({
    title: z.string('title 必须是字符串').trim().max(LIMITS.title, `title 最长 ${LIMITS.title} 个字符`).optional(),
    layers: z.array(LayerInputSchema).max(LIMITS.layers, `最多 ${LIMITS.layers} 个图层`).default([]),
    intents: z.array(IntentSchema).max(200).optional(),
  })
  .superRefine((map, ctx) => {
    // Layer ids are document-wide; point ids are scoped to their layer, because
    // every EditOperation names a layerId alongside the pointId. Two routes may
    // both carry a point id of 'harbin'.
    const layerIds = new Map<string, string>();

    map.layers.forEach((layer, layerIndex) => {
      if (layer.id) {
        const owner = layerIds.get(layer.id);
        if (owner) {
          ctx.addIssue({
            code: 'custom',
            path: ['layers', layerIndex, 'id'],
            message: `重复的图层 id「${layer.id}」，已被图层「${owner}」使用`,
          });
        } else {
          layerIds.set(layer.id, layer.name);
        }
      }

      const pointIds = new Map<string, string>();
      layer.points?.forEach((point, pointIndex) => {
        if (!point.id) return;
        const owner = pointIds.get(point.id);
        if (owner) {
          ctx.addIssue({
            code: 'custom',
            path: ['layers', layerIndex, 'points', pointIndex, 'id'],
            message: `图层「${layer.name}」内重复的点 id「${point.id}」，已被点「${owner}」使用`,
          });
        } else {
          pointIds.set(point.id, point.name);
        }
      });
    });
  });

// --- Semantic edit operations --------------------------------------------

/**
 * Every edit payload is a closed set of fields, all the way down.
 *
 * `point.update` cannot carry `points`, `layer.update` cannot carry `points`
 * either — that is what `point.insert` / `point.delete` / `points.reorder` are
 * for. Rejecting the unknown key is the whole point: the previous strip
 * behaviour returned a new version with a name change applied and the points
 * silently dropped, which reads as success. The same applies one level down: a
 * `routing` object with `durationMinuts` misspelt must fail, not quietly store
 * routing without a duration.
 *
 * GeoJSON is the one exception. It is an external standard whose objects
 * legally carry foreign members (`bbox`, …) and whose `properties` is free-form
 * by definition, so it keeps the whole-map schema's lenient handling.
 */
const editLegSchema = z.strictObject(
  RouteLegSchema.shape,
  'routing.legs[] 只支持 fromPointId / toPointId / profile / distanceKm / durationMinutes / delayMinutes / legId / source / traffic / updatedAt / path / border / toll / tunnel / closed / note / color',
);
const editRoutingSchema = z.strictObject({
  ...RoutingInputSchema.shape,
  legs: z.array(editLegSchema).max(999).optional(),
}, 'routing 只支持 source / profile / distanceKm / durationMinutes / delayMinutes / updatedAt / legs');

const pointPatchSchema = z.strictObject({
  ...PointInputSchema.omit({ id: true }).partial().shape,
  day: PointInputSchema.shape.day.nullable(),
  flexibility: PointInputSchema.shape.flexibility.nullable(),
  icon: PointInputSchema.shape.icon.nullable(),
}, 'point.update 的 patch 只支持 name / at / day / note / warn / img / intent / flexibility / icon；增删或移动点位请用 point.insert / point.delete / point.reorder / points.reorder')
  .describe('只改这些字段：name / at / day / note / warn / img / intent / flexibility / icon。null 表示清除 day / flexibility / icon。未知字段会被拒绝，不会静默忽略。例：{"day":3,"note":"住一晚"}');
const layerPatchSchema = z.strictObject({
  ...LayerInputSchema.pick({
    name: true,
    kind: true,
    color: true,
    visible: true,
    from: true,
    note: true,
    intent: true,
  }).partial().shape,
  path: layerShape.path.nullable(),
  routing: editRoutingSchema.optional().nullable(),
}, 'layer.update 的 patch 只支持 name / kind / color / visible / from / note / intent / path / routing；要改点位请用 point.insert / point.update / point.delete / point.reorder / points.reorder')
  .describe('只改这些字段：name / kind / color / visible / from / note / intent / path / routing。不接受 points——增删改点位用 point.insert / point.update / point.delete，整段调序用 points.reorder。例：{"note":"改走内陆"}');

/** The insert payload is authored for this one edit, so unknown keys are a mistake, not a round trip. */
const pointPayloadSchema = z.strictObject(
  PointInputSchema.shape,
  'point.insert 的 point 只支持 id / name / at / day / note / warn / img / intent / flexibility / icon',
);

/**
 * `layer.add` takes a whole layer, so it is closed like every other edit — with
 * one concession: the fields Cartula itself derives (`stats`, `edited_by`,
 * `inputCrs`, `routingStatus`) are accepted and dropped, because undo replays a
 * layer the client read back from a snapshot. Anything else, including a
 * misspelt field, is rejected.
 */
const editLayerSchema = z.strictObject({
  ...layerShape,
  points: z.array(pointPayloadSchema).max(LIMITS.pointsPerLayer, `单个图层最多 ${LIMITS.pointsPerLayer} 个点`).optional(),
  routing: editRoutingSchema.optional(),
  stats: z.unknown().optional(),
  edited_by: z.unknown().optional(),
  inputCrs: z.unknown().optional(),
  routingStatus: z.unknown().optional(),
}, 'layer.add 的 layer 只支持 id / name / points / kind / color / visible / from / note / crs / geojson / path / routing / intent（Cartula 派生的 stats / edited_by / inputCrs / routingStatus 会被忽略）')
  .transform(({ stats: _stats, edited_by: _editedBy, inputCrs: _inputCrs, routingStatus: _routingStatus, ...layer }) => layer);

const insertOp = (op: 'insert' | 'point.insert') => z.strictObject({
  op: z.literal(op),
  layerId: idSchema,
  point: pointPayloadSchema,
  /** Insert after this point id; omitted means append. */
  after: idSchema.optional(),
});
const deleteOp = (op: 'delete' | 'point.delete') => z.strictObject({ op: z.literal(op), layerId: idSchema, pointId: idSchema });
const updateOp = (op: 'update' | 'point.update') => z.strictObject({ op: z.literal(op), layerId: idSchema, pointId: idSchema, patch: pointPatchSchema });
const reorderOp = (op: 'reorder' | 'point.reorder') => z.strictObject({
  op: z.literal(op),
  layerId: idSchema,
  pointId: idSchema,
  toIndex: z.number('toIndex 必须是数字').int('toIndex 必须是整数').min(0, 'toIndex 不能小于 0'),
}, 'point.reorder 需要 layerId、pointId 和 toIndex；整段顺序调整请用 points.reorder + pointIds')
  .describe('把一个地点移到某一站：{"op":"point.reorder","layerId":"plan-a","pointId":"a13","toIndex":0}。整段（例如反转 13 个点）用 points.reorder + pointIds，一次调用即可。');
const routeLegPatchSchema = z.strictObject({
  distanceKm: routingMetrics.distanceKm.nullable().optional(),
  durationMinutes: routingMetrics.durationMinutes.nullable().optional(),
  delayMinutes: routingMetrics.delayMinutes.nullable().optional(),
  profile: boundedText(80, 'profile').nullable().optional(),
  source: boundedText(200, 'source').nullable().optional(),
  traffic: trafficSchema.nullable().optional(),
  updatedAt: isoTimeSchema.nullable(),
  legId: idSchema.nullable().optional(),
  path: z.array(CoordSchema).max(LIMITS.pathCoords).nullable().optional(),
  border: z.boolean().nullable().optional(),
  toll: z.boolean().nullable().optional(),
  tunnel: z.boolean().nullable().optional(),
  closed: z.boolean().nullable().optional(),
  note: boundedText(LIMITS.note, 'note').nullable().optional(),
  color: colorSchema.nullable().optional(),
}, 'route.leg.update 的 patch 只支持 distanceKm / durationMinutes / delayMinutes / profile / source / traffic / updatedAt / legId / path / border / toll / tunnel / closed / note / color');

/** One semantic edit. Matches the `EditOperation` union in `types.ts`. */
export const EditOperationSchema = z.discriminatedUnion(
  'op',
  [
    insertOp('insert'),
    insertOp('point.insert'),
    deleteOp('delete'),
    deleteOp('point.delete'),
    updateOp('update'),
    updateOp('point.update'),
    z.strictObject({
      op: z.literal('annotate'),
      layerId: idSchema,
      pointId: idSchema,
      text: boundedText(LIMITS.note, 'text'),
    }),
    reorderOp('reorder'),
    reorderOp('point.reorder'),
    /** Whole-sequence reorder: one call for "reverse this 13-stop route". */
    z.strictObject({
      op: z.literal('points.reorder'),
      layerId: idSchema,
      pointIds: z
        .array(idSchema, 'pointIds 必须是点 id 组成的数组')
        .min(1, 'pointIds 不能为空')
        .max(LIMITS.pointsPerLayer, `pointIds 最多 ${LIMITS.pointsPerLayer} 个`)
        .describe('该图层全部点 id 的新顺序，必须是一次完整排列：不能重复、遗漏或包含其它图层的 id'),
    }, 'points.reorder 需要 layerId 和 pointIds（该图层全部点 id 的新顺序）')
      .describe('一次提交整段新顺序，例如把三个点反转：{"op":"points.reorder","layerId":"plan-a","pointIds":["a3","a2","a1"]}。重复/遗漏/陌生 id 会整批拒绝。'),
    z.strictObject({ op: z.literal('layer.add'), layer: editLayerSchema }),
    z.strictObject({ op: z.literal('layer.update'), layerId: idSchema, patch: layerPatchSchema }),
    z.strictObject({ op: z.literal('layer.delete'), layerId: idSchema }),
    z.strictObject({ op: z.literal('intent'), text: boundedText(LIMITS.layerNote, 'intent').min(1) }),
    z.strictObject({
      op: z.literal('intent.set'),
      scope: z.enum(['map', 'layer', 'point']),
      text: boundedText(LIMITS.layerNote, 'intent'),
      layerId: idSchema.optional(),
      pointId: idSchema.optional(),
      priority: z.enum(['must', 'prefer', 'avoid', 'optional']).optional(),
      status: z.enum(['active', 'resolved']).optional(),
    }),
    z.strictObject({
      op: z.literal('route.leg.update'),
      layerId: idSchema,
      fromPointId: idSchema,
      toPointId: idSchema,
      patch: routeLegPatchSchema,
    }),
    z.strictObject({ op: z.literal('draft.commit'), note: boundedText(LIMITS.note, 'note').optional() }),
  ],
  {
    error:
      'op 只能是 insert / point.insert / delete / point.delete / update / point.update / annotate / reorder / point.reorder / points.reorder / layer.add / layer.update / layer.delete / intent / intent.set / route.leg.update / draft.commit 之一',
  },
);

/** A batch of edits, applied in order and atomically by `applyOperations`. */
export const EditOperationsSchema = z
  .array(EditOperationSchema)
  .max(LIMITS.operations, `一次最多提交 ${LIMITS.operations} 个操作`);

// Compile-time guards: the parsed output must satisfy the hand-written types in
// types.ts. These produce no runtime code.
type Extends<Base, Sub extends Base> = Sub;
type _MapInputMatches = Extends<MapInput, z.output<typeof MapInputSchema>>;
type _EditOperationMatches = Extends<EditOperation, z.output<typeof EditOperationSchema>>;
type _IntentMatches = Extends<Intent, z.output<typeof IntentSchema>>;
