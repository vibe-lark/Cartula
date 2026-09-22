export type Coord = [number, number];
export type Geometry =
  | { type: 'Point'; coordinates: Coord }
  | { type: 'MultiPoint' | 'LineString'; coordinates: Coord[] }
  | { type: 'MultiLineString' | 'Polygon'; coordinates: Coord[][] }
  | { type: 'MultiPolygon'; coordinates: Coord[][][] };
export interface Feature {
  type: 'Feature'; geometry: Geometry;
  properties: Record<string, unknown> | null;
  id?: string | number;
}
export interface FeatureCollection { type: 'FeatureCollection'; features: Feature[] }

export type IntentPriority = 'must' | 'prefer' | 'avoid' | 'optional';
export type IntentScope = 'map' | 'layer' | 'point';
export type IntentStatus = 'active' | 'resolved';
/** First-class planning intent. Map / layer / point all share this shape. */
export interface Intent {
  scope: IntentScope;
  layerId?: string;
  pointId?: string;
  text: string;
  priority?: IntentPriority;
  status?: IntentStatus;
  author?: 'agent' | 'user';
}

export type PointIcon =
  | 'pin' | 'hotel' | 'restaurant' | 'cafe' | 'viewpoint' | 'museum' | 'park'
  | 'parking' | 'fuel' | 'airport' | 'station' | 'camp' | 'shop' | 'hospital' | 'note';
export interface PointInput {
  id?: string; name: string; at: Coord;
  day?: number; note?: string; warn?: boolean; img?: string;
  /** Free-text planning intent for this stop. Structured copy also lives on `MapInput.intents`. */
  intent?: string; flexibility?: 'fixed' | 'flexible';
  /** Custom marker; spots default to pin. Route stops stay numbered unless set. */
  icon?: PointIcon;
}
export interface MapPoint extends PointInput { id: string }

export type TrafficState = 'unknown' | 'clear' | 'moderate' | 'heavy' | 'closed';
export interface RouteLeg {
  fromPointId: string; toPointId: string; distanceKm?: number; durationMinutes?: number;
  /** Extra minutes on top of durationMinutes when a traffic source reported delay. Never inferred. */
  delayMinutes?: number;
  /** Per-leg transport mode (e.g. driving/walking/cycling/transit/flight/train/ferry). Overrides the layer-level `RoutingInput.profile` for display. */
  profile?: string;
  legId?: string;
  source?: string;
  traffic?: TrafficState;
  updatedAt?: string;
  /** Optional per-leg drawing geometry; never inferred. */
  path?: Coord[];
  border?: boolean;
  toll?: boolean;
  tunnel?: boolean;
  closed?: boolean;
  note?: string;
  /** Optional custom leg color. In day mode, a copy of layer.color still allows date shading. */
  color?: string;
}
export interface RoutingInput {
  source: string; profile?: string; distanceKm?: number; durationMinutes?: number;
  updatedAt?: string;
  legs?: RouteLeg[];
}
/**
 * How the stored road geometry of a layer came to be. Cartula writes it; it is
 * never accepted from a caller and never grants a quota exemption — that is
 * decided by whether the geometry matches what Cartula already stored.
 */
export interface RoutingStatus {
  /** `resolved`: a routing provider produced it. `simplified`: Cartula reduced supplied geometry to keep the map editable. */
  geometry: 'resolved' | 'simplified';
  provider?: string;
  profile?: string;
  /** Road coordinates stored for this layer (`path` and `routing.legs[].path` counted once when they mirror each other). */
  coordinates: number;
  updatedAt?: string;
  /**
   * Set when Cartula had to reduce the geometry, with how far it had to go:
   * distance tolerance, then even decimation, then dropping per-leg polylines
   * (`droppedLegPaths`; `legPathsRecoverable` when those were only the
   * stop-to-stop chord the renderer draws anyway), then keeping the whole line
   * as its endpoints only. Provider distance/duration are never recomputed.
   */
  simplified?: {
    reason: 'derived-budget';
    fromCoordinates: number; toCoordinates: number;
    toleranceMeters: number; decimated?: boolean;
    droppedLegPaths?: number; legPathsRecoverable?: boolean; endpointsOnly?: boolean;
  };
}
export interface LayerInput {
  id?: string; name: string; points?: PointInput[];
  kind?: 'route' | 'spots' | 'geojson'; color?: string;
  visible?: boolean; from?: string; note?: string;
  crs?: 'wgs84' | 'gcj02'; geojson?: FeatureCollection;
  /** Supplied road geometry; never inferred by Cartula. */
  path?: Coord[];
  routing?: RoutingInput;
  intent?: string;
}
export interface MapLayer extends Omit<LayerInput, 'points'> {
  id: string; points: MapPoint[]; kind: 'route' | 'spots' | 'geojson';
  color: string; visible: boolean; crs: 'wgs84';
  inputCrs?: 'gcj02'; edited_by: 'agent' | 'user';
  /** Derived provenance of `path` / `routing.legs[].path`. Server-written, stripped from write payloads. */
  routingStatus?: RoutingStatus;
  stats: { distanceKm: number; days: number; distanceKind: 'provided' | 'straight'; pointCount: number;
    straightDistanceKm?: number; geometryDistanceKm?: number; routingDistanceKm?: number; durationMinutes?: number; routingSource?: string };
}
export interface MapInput { title?: string; layers: LayerInput[]; intents?: Intent[] }
export interface SemanticEvent {
  version: number; actor: 'agent' | 'user'; at: string;
  changes: string[]; operations: EditOperation[] | { op: 'replace' }[];
  /** Agent-authored explanation of this version; shown in the UI as the adjustment reason. */
  reason?: string;
  /**
   * Which credential wrote this version — a stable, non-secret id (`sp_`, `ac_`
   * or `sh_`), never the key itself. `actor` says agent-or-user, which is a
   * role and not an identity: once a map is shared for editing, two Agents both
   * write `actor: 'agent'` and neither can recognise its own work without this.
   * Absent on versions written before the field existed.
   */
  author?: string;
}
export interface MapSnapshot {
  id: string; title: string; layers: MapLayer[];
  version: number; parent: number | null;
  /** Any change at all — by anyone — since `sinceVersion`. The one authoritative delta flag. */
  changed: boolean;
  /** Same window, split by author. Optional so offline drafts need not compute them. */
  hasUserChanges?: boolean; hasAgentChanges?: boolean;
  /** The version `changed` / `changes` / `events` are relative to. */
  sinceVersion?: number;
  /**
   * The version the Agent last wrote. Server-maintained; the default read
   * window when a caller passes no `since`.
   */
  agentVersion?: number;
  /**
   * The version a user last confirmed as handed to the conversation.
   * Server-maintained through `record_handoff`, and deliberately not the same
   * boundary as `agentVersion`: a submission that was never delivered, and
   * edits made while the Agent was replying, both sit above it.
   */
  handoffVersion?: number;
  changes: string[]; events: SemanticEvent[];
  updatedAt: string; url: string;
  intents?: Intent[];
}
/**
 * A write response. `spaceKey` (and its `editKey` / `editUrl` aliases) appears
 * only when this very call minted a new space; `spaceId` names the space the
 * map lives in and is not a credential.
 */
export interface WriteResult extends MapSnapshot { editKey?: string; editUrl?: string; spaceId?: string; spaceKey?: string }

export type PointPatch = Partial<Omit<PointInput, 'id' | 'day' | 'flexibility' | 'icon'>> & { day?: number | null; flexibility?: 'fixed' | 'flexible' | null; icon?: PointIcon | null };
export type LayerPatch = Partial<Pick<LayerInput, 'name' | 'kind' | 'color' | 'visible' | 'from' | 'note' | 'intent'>> & { path?: Coord[] | null; routing?: RoutingInput | null };
export type RouteLegPatch = Partial<{
  distanceKm: number | null; durationMinutes: number | null; delayMinutes: number | null; profile: string | null;
  source: string | null; traffic: TrafficState | null; updatedAt: string | null;
  legId: string | null; path: Coord[] | null; border: boolean | null; toll: boolean | null;
  tunnel: boolean | null; closed: boolean | null; note: string | null; color: string | null;
}>;

export type EditOperation =
  | { op: 'insert'; layerId: string; point: PointInput; after?: string }
  | { op: 'point.insert'; layerId: string; point: PointInput; after?: string }
  | { op: 'delete'; layerId: string; pointId: string }
  | { op: 'point.delete'; layerId: string; pointId: string }
  | { op: 'update'; layerId: string; pointId: string; patch: PointPatch }
  | { op: 'point.update'; layerId: string; pointId: string; patch: PointPatch }
  | { op: 'annotate'; layerId: string; pointId: string; text: string }
  | { op: 'reorder'; layerId: string; pointId: string; toIndex: number }
  | { op: 'point.reorder'; layerId: string; pointId: string; toIndex: number }
  /** Whole-sequence reorder: `pointIds` must be exactly the layer's point ids, in the new order. */
  | { op: 'points.reorder'; layerId: string; pointIds: string[] }
  | { op: 'layer.add'; layer: LayerInput }
  | { op: 'layer.update'; layerId: string; patch: LayerPatch }
  | { op: 'layer.delete'; layerId: string }
  | { op: 'intent'; text: string }
  | { op: 'intent.set'; scope: IntentScope; text: string; layerId?: string; pointId?: string; priority?: IntentPriority; status?: IntentStatus }
  | { op: 'route.leg.update'; layerId: string; fromPointId: string; toPointId: string; patch: RouteLegPatch }
  | { op: 'draft.commit'; note?: string };

export interface Suggestion { type: 'suggest'; text: string; highlight?: string[] }
export interface ChangeNotification {
  type: 'edit'; changes: string[]; version: number; actor: 'agent' | 'user'; reason?: string;
}
