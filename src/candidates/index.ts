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
  intersect: "Keep geometry shared by two spatial layers.",
  nearest: "Find the closest features between layers.",
  filter: "Filter a layer using deterministic attribute criteria.",
  select: "Select a set of features on the map.",
  export: "Export a result layer as GeoJSON.",
};

export function generateActionCandidates(state: JevMapState): CandidateAction[] {
  const layerIds = state.layers.map((layer) => layer.id);
  const candidates: CandidateAction[] = [
    candidate("buffer", layerIds),
    candidate("filter", layerIds),
    candidate("select", layerIds),
    candidate("export", layerIds),
  ];

  if (layerIds.length >= 2) {
    candidates.splice(1, 0, candidate("intersect", layerIds), candidate("nearest", layerIds));
  }

  return candidates;
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
