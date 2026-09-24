import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";

export type BBox = [west: number, south: number, east: number, north: number];

export interface FieldSummary {
  name: string;
  type: "string" | "number" | "boolean" | "null" | "mixed";
}

export interface SpatialSummary {
  featureCount: number;
  geometryTypes: string[];
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
}

export function summarizeFeatureCollection(
  id: string,
  name: string,
  collection: FeatureCollection<Geometry, GeoJsonProperties>,
  sampleSize = 25,
): LayerState {
  const geometryTypes = [...new Set(collection.features.map((feature) => feature.geometry?.type ?? "Null"))];
  const fields = summarizeFields(collection);
  const sample: FeatureCollection<Geometry, GeoJsonProperties> = {
    type: "FeatureCollection",
    features: collection.features.slice(0, sampleSize),
  };

  return {
    id,
    name,
    geometryType: geometryTypes.length === 1 ? (geometryTypes[0] ?? "Unknown") : "Mixed",
    featureCount: collection.features.length,
    fields,
    sample,
    summary: {
      featureCount: collection.features.length,
      geometryTypes,
    },
  };
}

function summarizeFields(
  collection: FeatureCollection<Geometry, GeoJsonProperties>,
): FieldSummary[] {
  const observed = new Map<string, Set<FieldSummary["type"]>>();

  for (const feature of collection.features.slice(0, 100)) {
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
