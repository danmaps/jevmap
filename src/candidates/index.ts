import type { JevMapState } from "../state/index.js";

export type SpatialToolId =
  | "buffer"
  | "intersect"
  | "nearest"
  | "filter"
  | "select"
  | "export";

export interface CandidateAction {
  id: SpatialToolId;
  description: string;
  eligibleLayerIds: string[];
}

export interface DistanceCandidate {
  id: string;
  meters: number;
  label: string;
}

export const DEFAULT_DISTANCE_CANDIDATES: readonly DistanceCandidate[] = [
  { id: "25m", meters: 25, label: "25 meters" },
  { id: "50m", meters: 50, label: "50 meters" },
  { id: "100m", meters: 100, label: "100 meters" },
  { id: "250m", meters: 250, label: "250 meters" },
  { id: "500m", meters: 500, label: "500 meters" },
  { id: "1km", meters: 1000, label: "1 kilometer" },
] as const;

const DESCRIPTIONS: Record<SpatialToolId, string> = {
  buffer: "Create a distance zone around input features.",
  intersect: "Select input features intersecting a polygon overlay (no geometry clipping).",
  nearest: "Find the closest features between layers.",
  filter: "Filter a layer using deterministic attribute criteria.",
  select: "Select a set of features on the map.",
  export: "Export a result layer as GeoJSON.",
};

export function generateActionCandidates(state: JevMapState): CandidateAction[] {
  const layerIds = state.layers.map((layer) => layer.id);
  if (layerIds.length === 0) return [];
  const spatial = state.layers.filter((layer) => layer.featureCount > 0 && layer.summary.geometryTypes.length > 0 && layer.summary.geometryTypes.every((type) => !["Null", "Unknown", "GeometryCollection"].includes(type))).map((layer) => layer.id);
  const points = state.layers.filter((layer) => layer.featureCount > 0 && layer.summary.geometryTypes.length === 1 && layer.summary.geometryTypes[0] === "Point").map((layer) => layer.id);
  const polygons = state.layers.filter((layer) => layer.featureCount > 0 && layer.summary.geometryTypes.length > 0 && layer.summary.geometryTypes.every((type) => ["Polygon", "MultiPolygon"].includes(type))).map((layer) => layer.id);
  const candidates: CandidateAction[] = [
    candidate("buffer", spatial),
    candidate("filter", state.layers.filter((layer) => layer.fields.length > 0).map((layer) => layer.id)),
    candidate("select", layerIds),
    candidate("export", layerIds),
  ];

  if (layerIds.length >= 2) {
    candidates.splice(1, 0, candidate("intersect", spatial.filter((id) => polygons.some((other) => other !== id))), candidate("nearest", points.length >= 2 ? points : []));
  }

  return candidates.map((item) => ({ ...item, eligibleLayerIds: item.eligibleLayerIds.filter((id) => {
    const input = state.layers.find((layer) => layer.id === id)!;
    if (input.capabilities && !input.capabilities.includes(item.id)) return false;
    if (item.id === "nearest" || item.id === "intersect") {
      const others = item.id === "nearest" ? points : polygons;
      return others.some((otherId) => otherId !== id && (!state.layers.find((layer) => layer.id === otherId)!.capabilities || state.layers.find((layer) => layer.id === otherId)!.capabilities!.includes(item.id)));
    }
    return true;
  }) })).filter((item) => item.eligibleLayerIds.length > 0);
}

export function generateBufferCandidates(state: JevMapState): CandidateAction[] {
  const eligibleLayerIds = state.layers
    .filter(
      (layer) =>
        layer.featureCount > 0 &&
        layer.summary.geometryTypes.some((geometryType) => geometryType !== "Null"),
    )
    .map((layer) => layer.id);

  return eligibleLayerIds.length > 0 ? [candidate("buffer", eligibleLayerIds)] : [];
}

export function actionCriteria(candidates: readonly CandidateAction[]): Record<string, string> {
  return Object.fromEntries(candidates.map((item) => [item.id, item.description]));
}

export function layerCriteria(
  state: JevMapState,
  eligibleLayerIds: readonly string[] = state.layers.map((layer) => layer.id),
): Record<string, string> {
  return Object.fromEntries(
    state.layers.filter((layer) => eligibleLayerIds.includes(layer.id)).map((layer) => [
      layer.id,
      `${layer.name}: ${layer.featureCount} feature(s), geometry ${layer.geometryType}`,
    ]),
  );
}

export function distanceCriteria(
  candidates: readonly DistanceCandidate[] = DEFAULT_DISTANCE_CANDIDATES,
): Record<string, string> {
  return Object.fromEntries(
    candidates.map((item) => [item.id, `Use a buffer distance of ${item.label}.`]),
  );
}

function candidate(id: SpatialToolId, eligibleLayerIds: string[]): CandidateAction {
  return {
    id,
    description: DESCRIPTIONS[id],
    eligibleLayerIds,
  };
}
