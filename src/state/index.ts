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
