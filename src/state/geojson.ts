import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";

export function parseFeatureCollection(
  text: string,
): FeatureCollection<Geometry, GeoJsonProperties> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (!isRecord(value) || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw new Error("Expected a GeoJSON FeatureCollection.");
  }

  for (const feature of value.features) {
    if (!isRecord(feature) || feature.type !== "Feature") {
      throw new Error("Each item must be a GeoJSON Feature.");
    }
    if (feature.geometry === null) continue;
    if (!isRecord(feature.geometry)) throw new Error("Each feature must have a supported geometry.");
    if (feature.properties !== null && feature.properties !== undefined && !isRecord(feature.properties)) {
      throw new Error("Feature properties must be an object or null.");
    }
    validateGeometry(feature.geometry);
  }

  return value as unknown as FeatureCollection<Geometry, GeoJsonProperties>;
}

function validateGeometry(value: Record<string, unknown>): void {
  const supportedTypes = new Set([
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
  ]);
  if (typeof value.type !== "string" || !supportedTypes.has(value.type)) {
    throw new Error("A feature uses an unsupported geometry type.");
  }
  if (value.type === "GeometryCollection") {
    if (!Array.isArray(value.geometries)) throw new Error("A GeometryCollection is malformed.");
    for (const geometry of value.geometries) {
      if (!isRecord(geometry)) throw new Error("A GeometryCollection contains an invalid geometry.");
      validateGeometry(geometry);
    }
    return;
  }
  if (!Array.isArray(value.coordinates) || !hasCoordinatePosition(value.coordinates)) {
    throw new Error("A feature geometry is missing valid coordinates.");
  }
}

function hasCoordinatePosition(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (typeof value[0] === "number" || typeof value[1] === "number") {
    return (
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number" &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1])
    );
  }
  return value.some(hasCoordinatePosition);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
