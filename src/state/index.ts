import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";
import { generateActionCandidates } from "../candidates/index.js";

export type BBox = [west: number, south: number, east: number, north: number];

export interface FieldSummary {
  name: string;
  type: "string" | "number" | "boolean" | "null" | "mixed";
}

export interface SpatialSummary {
  featureCount: number;
  geometryTypes: string[];
}

export interface LayerProvenance {
  tool: string;
  sourceLayerIds: string[];
  receiptId?: string;
}

export interface LayerState {
  id: string;
  name: string;
  geometryType: string;
  featureCount: number;
  fields: FieldSummary[];
  extent?: BBox;
  sample?: FeatureCollection<Geometry, GeoJsonProperties>;
  summary: SpatialSummary;
  provenance?: LayerProvenance;
  capabilities?: string[];
}

export interface ActionReceiptSummary {
  id: string;
  selectedAction: string;
  confidence: number;
  success: boolean;
}

export interface JevMapState {
  intent: string;
  viewport: {
    bbox: BBox;
    zoom: number;
    bearing?: number;
    pitch?: number;
  };
  layers: LayerState[];
  selection: {
    layerId?: string;
    featureIds: string[];
  };
  previousActions: ActionReceiptSummary[];
  activeResultLayerIds?: string[];
}

export interface ScopedGeometrySummary {
  layerId: string;
  purpose: string;
  /** Calculate these metrics deterministically before requesting model judgment. */
  metrics: Record<string, number | boolean | null>;
}

export interface SemanticMapStateOptions {
  maxSelectionIds?: number;
  maxPreviousActions?: number;
  maxFieldsPerLayer?: number;
  geometrySummaries?: readonly ScopedGeometrySummary[];
}

export interface SemanticLayerState {
  id: string;
  name: string;
  geometryType: string;
  geometryTypes: string[];
  featureCount: number;
  fields: FieldSummary[];
  fieldCount: number;
  extent?: BBox;
  provenance: { kind: "source" } | (LayerProvenance & { kind: "derived" });
  capabilities: string[];
}

export interface SemanticMapState extends Record<string, unknown> {
  intent: string;
  viewport: JevMapState["viewport"];
  layers: SemanticLayerState[];
  selection: { layerId?: string; count: number; featureIds: string[]; omittedCount: number };
  activeResultLayerIds: string[];
  previousActions: ActionReceiptSummary[];
  previousActionCount: number;
  geometrySummaries?: ScopedGeometrySummary[];
}

const SPATIAL_CAPABILITIES = ["buffer", "intersect", "nearest", "filter", "select", "export"];

/**
 * Model context contains semantic metadata only. GeoJSON samples and coordinate arrays
 * remain in application state for candidate validation, execution and replay.
 */
export function semanticMapState(state: JevMapState, options: SemanticMapStateOptions = {}): SemanticMapState {
  const selectionLimit = boundedLimit(options.maxSelectionIds, 20, 100);
  const historyLimit = boundedLimit(options.maxPreviousActions, 10, 100);
  const fieldLimit = boundedLimit(options.maxFieldsPerLayer, 40, 200);
  const layerIds = new Set(state.layers.map((layer) => layer.id));
  const selectedIds = [...new Set(state.selection.featureIds)].sort();
  const capabilityMap = new Map(state.layers.map((layer) => [layer.id, [] as string[]]));
  for (const candidate of generateActionCandidates(state)) {
    for (const id of candidate.eligibleLayerIds) capabilityMap.get(id)?.push(candidate.id);
  }
  const layers = [...state.layers].sort((a, b) => compareStrings(a.id, b.id)).map((layer): SemanticLayerState => ({
    id: layer.id,
    name: layer.name,
    geometryType: layer.geometryType,
    geometryTypes: [...new Set(layer.summary.geometryTypes)].sort(),
    featureCount: layer.featureCount,
    fields: [...layer.fields].sort((a, b) => compareStrings(a.name, b.name)).slice(0, fieldLimit).map((field) => ({ name: field.name, type: field.type })),
    fieldCount: layer.fields.length,
    ...(layer.extent ? { extent: [...layer.extent] as BBox } : {}),
    provenance: layer.provenance ? {
      kind: "derived",
      tool: layer.provenance.tool,
      sourceLayerIds: [...new Set(layer.provenance.sourceLayerIds)].sort(),
      ...(layer.provenance.receiptId ? { receiptId: layer.provenance.receiptId } : {}),
    } : { kind: "source" },
    capabilities: layer.capabilities ? [...new Set(layer.capabilities)].filter((capability) => SPATIAL_CAPABILITIES.includes(capability)).sort()
      : [...(capabilityMap.get(layer.id) ?? [])].sort(),
  }));
  const geometrySummaries = options.geometrySummaries?.map((summary) => {
    if (!layerIds.has(summary.layerId)) throw new Error(`Unknown geometry summary layer "${summary.layerId}".`);
    if (!summary.purpose.trim()) throw new Error("A scoped geometry summary requires a purpose.");
    if (Object.keys(summary.metrics).length > 32 || Object.values(summary.metrics).some((value) => value !== null && typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value)))) {
      throw new Error("Geometry summaries require at most 32 finite numeric, boolean or null metrics; GeoJSON is not allowed.");
    }
    return {
      layerId: summary.layerId,
      purpose: summary.purpose,
      metrics: Object.fromEntries(Object.entries(summary.metrics).sort(([a], [b]) => compareStrings(a, b))),
    };
  }).sort((a, b) => compareStrings(a.layerId, b.layerId) || compareStrings(a.purpose, b.purpose));

  return {
    intent: state.intent,
    viewport: {
      bbox: [...state.viewport.bbox],
      zoom: state.viewport.zoom,
      ...(state.viewport.bearing === undefined ? {} : { bearing: state.viewport.bearing }),
      ...(state.viewport.pitch === undefined ? {} : { pitch: state.viewport.pitch }),
    },
    layers,
    selection: {
      ...(state.selection.layerId ? { layerId: state.selection.layerId } : {}),
      count: selectedIds.length,
      featureIds: selectedIds.slice(0, selectionLimit),
      omittedCount: Math.max(0, selectedIds.length - selectionLimit),
    },
    activeResultLayerIds: [...new Set([
      ...(state.activeResultLayerIds ?? []).filter((id) => layerIds.has(id)),
      ...state.layers.filter((layer) => layer.provenance).map((layer) => layer.id),
    ])].sort(),
    previousActions: (historyLimit ? state.previousActions.slice(-historyLimit) : []).map((action) => ({
      id: action.id, selectedAction: action.selectedAction, confidence: action.confidence, success: action.success,
    })),
    previousActionCount: state.previousActions.length,
    ...(geometrySummaries?.length ? { geometrySummaries } : {}),
  };
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined ? fallback : Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.floor(value))) : fallback;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function summarizeFeatureCollection(
  id: string,
  name: string,
  collection: FeatureCollection<Geometry, GeoJsonProperties>,
  sampleSize = 25,
): LayerState {
  const geometryTypes = [...new Set(collection.features.map((feature) => feature.geometry?.type ?? "Null"))];
  const fields = summarizeFields(collection);
  const safeSampleSize = Number.isFinite(sampleSize) ? Math.max(0, Math.floor(sampleSize)) : 25;
  const sample: FeatureCollection<Geometry, GeoJsonProperties> = {
    type: "FeatureCollection",
    features: collection.features.slice(0, safeSampleSize),
  };
  const extent = featureCollectionExtent(collection);

  return {
    id,
    name,
    geometryType:
      geometryTypes.length === 0
        ? "Unknown"
        : geometryTypes.length === 1
          ? (geometryTypes[0] ?? "Unknown")
          : "Mixed",
    featureCount: collection.features.length,
    fields,
    ...(extent ? { extent } : {}),
    sample,
    summary: {
      featureCount: collection.features.length,
      geometryTypes,
    },
  };
}

function featureCollectionExtent(
  collection: FeatureCollection<Geometry, GeoJsonProperties>,
): BBox | undefined {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let foundPosition = false;

  const visitCoordinates = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) return;

    if (
      coordinates.length >= 2 &&
      typeof coordinates[0] === "number" &&
      typeof coordinates[1] === "number"
    ) {
      const x = coordinates[0];
      const y = coordinates[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
      foundPosition = true;
      return;
    }

    for (const coordinate of coordinates) visitCoordinates(coordinate);
  };

  const visitGeometry = (geometry: Geometry): void => {
    if (geometry.type === "GeometryCollection") {
      for (const child of geometry.geometries) visitGeometry(child);
      return;
    }
    visitCoordinates(geometry.coordinates);
  };

  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    visitGeometry(geometry);
  }

  return foundPosition ? [west, south, east, north] : undefined;
}

function summarizeFields(
  collection: FeatureCollection<Geometry, GeoJsonProperties>,
): FieldSummary[] {
  const observed = new Map<string, Set<FieldSummary["type"]>>();

  for (const feature of collection.features) {
    for (const [name, value] of Object.entries(feature.properties ?? {})) {
      const types = observed.get(name) ?? new Set<FieldSummary["type"]>();
      types.add(value === null ? "null" : normalizePropertyType(typeof value));
      observed.set(name, types);
    }
  }

  return [...observed.entries()].map(([name, types]) => ({
    name,
    type: types.size === 1 ? ([...types][0] ?? "null") : "mixed",
  }));
}

function normalizePropertyType(type: string): FieldSummary["type"] {
  if (type === "string" || type === "number" || type === "boolean") return type;
  return "mixed";
}
