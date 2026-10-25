import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";
import type { SpatialToolId } from "../candidates/index.js";

export interface SpatialToolDefinition { id: SpatialToolId; description: string; status: "implemented" | "planned" }
export const WORKBENCH_REGISTRY: readonly SpatialToolDefinition[] = [
  { id: "buffer", description: "Create a metric buffer.", status: "implemented" },
  { id: "intersect", description: "Select input features intersecting a polygon overlay.", status: "implemented" },
  { id: "nearest", description: "Connect points to nearest target points.", status: "implemented" },
  { id: "filter", description: "Filter by an exact scalar attribute value.", status: "implemented" },
  { id: "select", description: "Select bounded feature IDs.", status: "implemented" },
  { id: "export", description: "Serialize GeoJSON.", status: "implemented" },
];
export type SpatialData = FeatureCollection<Geometry, GeoJsonProperties>;
export type BufferCall = { tool: "buffer"; args: { layerId: string; distanceMeters: number } };
export type ExportCall = { tool: "export"; args: { layerId: string; format?: "geojson" } };
export type IntersectCall = { tool: "intersect"; args: { layerId: string; overlayLayerId: string } };
export type NearestCall = { tool: "nearest"; args: { layerId: string; targetLayerId: string } };
export type FilterCall = { tool: "filter"; args: { layerId: string; field: string; value: string | number | boolean | null } };
export type SelectCall = { tool: "select"; args: { layerId: string; featureIds: string[] } };
export type WorkbenchCall = BufferCall | ExportCall | IntersectCall | NearestCall | FilterCall | SelectCall;
export interface WorkbenchContext { layers: ReadonlyMap<string, SpatialData>; capabilities?: ReadonlyMap<string, readonly SpatialToolId[]>; maxFeatures?: number; maxPairComparisons?: number; maxExportBytes?: number }
export interface WorkbenchResult { tool: SpatialToolId; layerId: string; data: SpatialData }
export class ExecutionBoundaryError extends Error {}
export function workbenchDecisionValues(call: WorkbenchCall): Record<string, unknown> {
  const values: Record<string, unknown> = { action: call.tool, layer: call.args.layerId };
  if (call.tool === "buffer") values.distance = call.args.distanceMeters;
  if (call.tool === "nearest") values.overlay = call.args.targetLayerId;
  if (call.tool === "intersect") values.overlay = call.args.overlayLayerId;
  if (call.tool === "filter") values.predicate = { field: call.args.field, value: call.args.value };
  if (call.tool === "select") values.selection = call.args.featureIds;
  if (call.tool === "export") values.format = call.args.format ?? "geojson";
  return values;
}
export function featureId(feature: SpatialData["features"][number], index: number): string { return String(feature.id ?? `feature-${index}`); }
const ARGUMENT_KEYS: Record<SpatialToolId, readonly string[]> = {
  buffer: ["layerId", "distanceMeters"], intersect: ["layerId", "overlayLayerId"], nearest: ["layerId", "targetLayerId"],
  filter: ["layerId", "field", "value"], select: ["layerId", "featureIds"], export: ["layerId", "format"],
};

export function validateWorkbenchCall(call: WorkbenchCall, context: WorkbenchContext): void {
  if (!isPlainRecord(call) || !WORKBENCH_REGISTRY.some((item) => item.id === call.tool)) throw new Error("Unknown workbench tool.");
  if (Object.keys(call).some((key) => key !== "tool" && key !== "args")) throw new Error("Workbench call contains an unknown field.");
  if (!isPlainRecord(call.args) || typeof call.args.layerId !== "string" || !call.args.layerId.trim()) throw new Error("Workbench call requires a layer ID.");
  if (Object.keys(call.args).some((key) => !ARGUMENT_KEYS[call.tool].includes(key))) throw new Error(`Unknown ${call.tool} argument.`);
  for (const name of ["maxFeatures", "maxPairComparisons", "maxExportBytes"] as const) {
    const configured = context[name];
    if (configured !== undefined && (!Number.isSafeInteger(configured) || configured <= 0)) throw new Error(`${name} must be a positive finite integer.`);
  }
  const input = context.layers.get(call.args.layerId);
  if (!input) throw new Error(`Unknown layer: ${call.args.layerId}`);
  const requiredIds = [call.args.layerId, ...("targetLayerId" in call.args ? [call.args.targetLayerId] : "overlayLayerId" in call.args ? [call.args.overlayLayerId] : [])];
  for (const id of requiredIds) if (context.capabilities?.has(id) && !context.capabilities.get(id)!.includes(call.tool)) throw new Error(`Layer ${id} does not support ${call.tool}.`);
  if (!isPlainRecord(input) || input.type !== "FeatureCollection" || !Array.isArray(input.features)) throw new Error("Workbench input must be a GeoJSON FeatureCollection.");
  const limit = context.maxFeatures ?? 10_000;
  if (call.tool !== "export" && input.features.length > limit) throw new Error(`Browser feature limit (${limit}) exceeded. Reduce the layer before analysis.`);
  validateLayerGeometry(input);
  if (call.tool === "export") {
    if (call.args.format !== undefined && call.args.format !== "geojson") throw new Error("Only GeoJSON export is supported.");
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > (context.maxExportBytes ?? 20_000_000)) throw new Error("Export exceeds the browser size limit. Reduce the layer before exporting.");
    return;
  }
  if (call.tool === "buffer") {
    if (!Number.isFinite(call.args.distanceMeters) || call.args.distanceMeters <= 0 || call.args.distanceMeters > 100_000) throw new Error("Buffer distance must be a positive finite number no greater than 100000 meters.");
    if (!input.features.length || input.features.some((feature) => !feature.geometry || feature.geometry.type === "GeometryCollection")) throw new Error("Buffer requires nonempty point, line, or polygon geometry.");
  }
  if (call.tool === "filter") {
    if (typeof call.args.field !== "string" || !input.features.some((feature) => Object.hasOwn(feature.properties ?? {}, call.args.field))) throw new Error(`Missing filter field: ${call.args.field}`);
    const value = call.args.value;
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("Filter values must be scalar.");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Filter value must be finite.");
  }
  if (call.tool === "select") {
    const ids = new Set(input.features.map(featureId));
    if (!Array.isArray(call.args.featureIds) || call.args.featureIds.some((id) => typeof id !== "string" || !ids.has(id))) throw new Error("Selection contains an unavailable feature ID.");
    if (new Set(call.args.featureIds).size !== call.args.featureIds.length) throw new Error("Selection feature IDs must be unique.");
  }
  if (call.tool === "nearest" || call.tool === "intersect") {
    const otherId = call.tool === "nearest" ? call.args.targetLayerId : call.args.overlayLayerId;
    if (typeof otherId !== "string" || !otherId.trim()) throw new Error("Pairwise operations require a target or overlay layer ID.");
    const other = context.layers.get(otherId);
    if (!other) throw new Error(`Unknown layer: ${otherId}`);
    if (!isPlainRecord(other) || other.type !== "FeatureCollection" || !Array.isArray(other.features)) throw new Error("Workbench input must be a GeoJSON FeatureCollection.");
    if (otherId === call.args.layerId) throw new Error("Pairwise operations require distinct layers.");
    if (!input.features.length || !other.features.length) throw new Error("Pairwise operations require nonempty layers.");
    if (other.features.length > limit || input.features.length * other.features.length > (context.maxPairComparisons ?? 250_000)) throw new Error("Pairwise analysis exceeds the browser comparison limit. Reduce the layers first.");
    validateLayerGeometry(other);
    if (call.tool === "nearest" && [...input.features, ...other.features].some((feature) => feature.geometry?.type !== "Point")) throw new Error("Nearest requires Point geometry in both layers.");
    if (call.tool === "intersect" && (other.features.some((feature) => !["Polygon", "MultiPolygon"].includes(feature.geometry?.type ?? "")) || input.features.some((feature) => !feature.geometry || feature.geometry.type === "GeometryCollection"))) throw new Error("Intersect requires a polygon overlay and supported input geometry.");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateLayerGeometry(data: SpatialData): void {
  for (const feature of data.features) {
    if (!isPlainRecord(feature) || feature.type !== "Feature" || (feature.properties != null && !isPlainRecord(feature.properties))) throw new Error("Workbench input contains an invalid GeoJSON feature.");
    if (feature.id !== undefined && typeof feature.id !== "string" && !(typeof feature.id === "number" && Number.isFinite(feature.id))) throw new Error("GeoJSON feature IDs must be strings or finite numbers.");
    if (feature.geometry !== null) validateGeometry(feature.geometry);
  }
}

function validateGeometry(value: unknown): void {
  if (!isPlainRecord(value)) throw new Error("Workbench input contains invalid geometry.");
  if (value.type === "GeometryCollection") {
    if (!Array.isArray(value.geometries)) throw new Error("Workbench input contains invalid geometry.");
    for (const geometry of value.geometries) validateGeometry(geometry);
    return;
  }
  const depths: Record<string, number> = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };
  if (typeof value.type !== "string" || !Object.hasOwn(depths, value.type) || !validCoordinates(value.coordinates, depths[value.type]!)) throw new Error("Workbench geometry requires a supported type and finite coordinates.");
  const coordinates = value.coordinates as unknown[][];
  if ((value.type === "LineString" && coordinates.length < 2) || (value.type === "MultiLineString" && coordinates.some((line) => line.length < 2))) throw new Error("Line geometry requires at least two positions.");
  const polygons = value.type === "Polygon" ? [coordinates] : value.type === "MultiPolygon" ? coordinates as unknown[][][] : [];
  for (const polygon of polygons) for (const ring of polygon) {
    const first = ring[0] as number[];
    const last = ring.at(-1) as number[];
    if (ring.length < 4 || first.length !== last.length || first.some((coordinate, index) => coordinate !== last[index])) throw new Error("Polygon geometry requires closed rings with at least four positions.");
  }
}

function validCoordinates(value: unknown, depth: number): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return depth === 0
    ? value.length >= 2 && value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
    : value.every((coordinates) => validCoordinates(coordinates, depth - 1));
}

export async function executeWorkbenchCall(call: WorkbenchCall, context: WorkbenchContext, options: { beforeExecute?: () => void } = {}): Promise<WorkbenchResult> {
  validateWorkbenchCall(call, context);
  const serialize = () => JSON.stringify([call, [...context.layers], context.capabilities && [...context.capabilities], context.maxFeatures, context.maxPairComparisons, context.maxExportBytes]);
  const snapshot = serialize();
  const turf = call.tool === "export" ? undefined : await import("@turf/turf");
  if (serialize() !== snapshot) throw new ExecutionBoundaryError("Workbench inputs changed while loading the geometry engine. Request a fresh decision.");
  options.beforeExecute?.();
  validateWorkbenchCall(call, context);
  const input = context.layers.get(call.args.layerId)!;
  if (call.tool === "export") return { tool: call.tool, layerId: call.args.layerId, data: input };
  let output: SpatialData;
  if (call.tool === "buffer") {
    const buffered = turf!.buffer(input, call.args.distanceMeters, { units: "meters" });
    if (!buffered) throw new Error("Buffer operation returned no geometry.");
    output = buffered as SpatialData;
  } else if (call.tool === "filter") {
    output = { type: "FeatureCollection", features: input.features.filter((feature) => Object.hasOwn(feature.properties ?? {}, call.args.field) && feature.properties?.[call.args.field] === call.args.value) };
  } else if (call.tool === "select") {
    const ids = new Set(call.args.featureIds);
    output = { type: "FeatureCollection", features: input.features.filter((feature, index) => ids.has(featureId(feature, index))) };
  } else if (call.tool === "intersect") {
    const overlay = context.layers.get(call.args.overlayLayerId)!;
    output = { type: "FeatureCollection", features: input.features.filter((feature) => overlay.features.some((polygon) => turf!.booleanIntersects(feature, polygon))) };
  } else {
    const targets = context.layers.get(call.args.targetLayerId)!;
    output = { type: "FeatureCollection", features: input.features.map((feature) => {
      if (feature.geometry.type !== "Point") throw new Error("Nearest requires Point input.");
      let best = targets.features[0]!;
      let closest = Number.POSITIVE_INFINITY;
      for (const candidate of targets.features) {
        if (candidate.geometry.type !== "Point") throw new Error("Nearest requires Point targets.");
        const meters = turf!.distance(turf!.point(feature.geometry.coordinates), turf!.point(candidate.geometry.coordinates), { units: "meters" });
        if (meters < closest) { best = candidate; closest = meters; }
      }
      if (best.geometry.type !== "Point") throw new Error("Nearest requires Point targets.");
      return { type: "Feature" as const, properties: { ...feature.properties, nearest: best.properties?.name ?? best.id ?? "target", distanceMeters: closest }, geometry: { type: "LineString" as const, coordinates: [feature.geometry.coordinates, best.geometry.coordinates] } };
    }) };
  }
  return { tool: call.tool, layerId: call.tool === "buffer" ? `${call.args.layerId}__buffer_${call.args.distanceMeters}m` : `${call.args.layerId}__${call.tool}`, data: output };
}
