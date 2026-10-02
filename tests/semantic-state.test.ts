import type { FeatureCollection, Geometry } from "geojson";
import { describe, expect, it } from "vitest";
import { semanticMapState, summarizeFeatureCollection, type JevMapState } from "../src/state/index.js";

function collection(geometry: Geometry, count = 1): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: Array.from({ length: count }, (_, index) => ({
      type: "Feature", id: `feature-${index}`, geometry,
      properties: { name: `Feature ${index}`, category: "source", count: index },
    })),
  };
}

function state(data: FeatureCollection): JevMapState {
  return {
    intent: "Buffer the roads",
    viewport: { bbox: [-2, 49, 1, 53], zoom: 10, bearing: 0, pitch: 0 },
    layers: [summarizeFeatureCollection("source", "Source", data)],
    selection: { featureIds: [] }, previousActions: [],
  };
}

function hasGeometryPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, "coordinates") || Object.hasOwn(record, "sample") || Object.hasOwn(record, "features") || record.type === "FeatureCollection" ||
    Object.values(record).some(hasGeometryPayload);
}

describe("geometry-free semantic map context", () => {
  it.each([
    { type: "Point", coordinates: [-0.1, 51.5] },
    { type: "LineString", coordinates: [[-0.2, 51.4], [-0.1, 51.5]] },
    { type: "Polygon", coordinates: [[[-0.2, 51.4], [-0.1, 51.4], [-0.1, 51.5], [-0.2, 51.4]]] },
  ] as Geometry[])("projects %s geometry to metadata and extent without feature payload", (geometry) => {
    const input = state(collection(geometry));
    const result = semanticMapState(input);
    expect(result.layers[0]).toMatchObject({ id: "source", name: "Source", geometryTypes: [geometry.type], featureCount: 1, provenance: { kind: "source" } });
    expect(result.layers[0]?.extent).toEqual(input.layers[0]?.extent);
    expect(result.layers[0]?.fields).toEqual([
      { name: "category", type: "string" }, { name: "count", type: "number" }, { name: "name", type: "string" },
    ]);
    expect(result.layers[0]?.capabilities).toEqual(["buffer", "export", "filter", "select"]);
    expect(hasGeometryPayload(result)).toBe(false);
    expect(input.layers[0]?.sample?.features).toHaveLength(1);
  });

  it("handles empty layers and empty selections explicitly", () => {
    const result = semanticMapState(state({ type: "FeatureCollection", features: [] }));
    expect(result.layers[0]).toMatchObject({ featureCount: 0, geometryTypes: [], fields: [], capabilities: ["export", "select"] });
    expect(result.layers[0]?.extent).toBeUndefined();
    expect(result.selection).toEqual({ count: 0, featureIds: [], omittedCount: 0 });
    expect(result.previousActionCount).toBe(0);
    expect(hasGeometryPayload(result)).toBe(false);
  });

  it("keeps multiple layer identities, capabilities, active results and provenance inspectable", () => {
    const input = state(collection({ type: "Point", coordinates: [-0.1, 51.5] }));
    const derived = summarizeFeatureCollection("result", "Buffered Source", collection({ type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] }));
    derived.provenance = { tool: "buffer", sourceLayerIds: ["source"], receiptId: "receipt-1" };
    derived.capabilities = ["export", "select", "export", "unsupported-tool"];
    input.layers.push(derived);
    input.activeResultLayerIds = ["result", "unknown"];
    input.previousActions.push({ id: "receipt-1", selectedAction: "buffer", confidence: 0.9, success: true });
    const result = semanticMapState(input);
    expect(result.layers.map((layer) => layer.id)).toEqual(["result", "source"]);
    expect(result.layers[0]?.provenance).toEqual({ kind: "derived", tool: "buffer", sourceLayerIds: ["source"], receiptId: "receipt-1" });
    expect(result.layers[0]?.capabilities).toEqual(["export", "select"]);
    expect(result.layers[1]?.capabilities).toContain("intersect");
    expect(result.layers[1]?.capabilities).not.toContain("nearest");
    expect(result.activeResultLayerIds).toEqual(["result"]);
    expect(result.previousActions).toEqual(input.previousActions);
    expect(hasGeometryPayload(result)).toBe(false);
  });

  it("derives capabilities from the same geometry eligibility as legal candidates", () => {
    const input = state(collection({ type: "Point", coordinates: [0, 0] }));
    input.layers.push(summarizeFeatureCollection("other", "Other", collection({ type: "Point", coordinates: [1, 1] })));
    expect(semanticMapState(input).layers.every((layer) => layer.capabilities.includes("nearest"))).toBe(true);
    const lines = state(collection({ type: "LineString", coordinates: [[0, 0], [1, 1]] }));
    lines.layers.push(summarizeFeatureCollection("other", "Other", collection({ type: "LineString", coordinates: [[2, 2], [3, 3]] })));
    expect(semanticMapState(lines).layers.some((layer) => layer.capabilities.includes("nearest"))).toBe(false);
    expect(semanticMapState(lines).layers.some((layer) => layer.capabilities.includes("intersect"))).toBe(false);
    const unsupported = state(collection({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [0, 0] }] }));
    expect(semanticMapState(unsupported).layers[0]?.capabilities).not.toContain("buffer");
  });

  it("normalizes selections with bounded IDs and preserves counts", () => {
    const input = state(collection({ type: "Point", coordinates: [0, 0] }));
    input.selection = { layerId: "source", featureIds: ["c", "a", "b", "a"] };
    expect(semanticMapState(input, { maxSelectionIds: 2 }).selection).toEqual({ layerId: "source", count: 3, featureIds: ["a", "b"], omittedCount: 1 });
    expect(semanticMapState(input, { maxSelectionIds: 0 }).selection).toEqual({ layerId: "source", count: 3, featureIds: [], omittedCount: 3 });
  });

  it("projects only recent action metadata and bounded field schemas", () => {
    const input = state(collection({ type: "Point", coordinates: [0, 0] }));
    input.previousActions = Array.from({ length: 15 }, (_, index) => ({ id: `receipt-${index}`, selectedAction: "buffer", confidence: 1, success: true }));
    const result = semanticMapState(input, { maxFieldsPerLayer: 1, maxPreviousActions: 2 });
    expect(result.layers[0]?.fieldCount).toBe(3);
    expect(result.layers[0]?.fields).toHaveLength(1);
    expect(result.previousActionCount).toBe(15);
    expect(result.previousActions.map((action) => action.id)).toEqual(["receipt-13", "receipt-14"]);
    expect(semanticMapState(input, { maxPreviousActions: 0 }).previousActions).toEqual([]);
  });

  it("includes fields first observed beyond feature 100 without including raw attributes", () => {
    const data = collection({ type: "Point", coordinates: [0, 0] }, 150);
    data.features[149]!.properties!.lateOnly = 42;
    const input = state(data);
    expect(input.layers[0]?.fields).toContainEqual({ name: "lateOnly", type: "number" });
    const result = semanticMapState(input);
    expect(result.layers[0]?.fields).toContainEqual({ name: "lateOnly", type: "number" });
    expect(result.layers[0]?.fieldCount).toBe(4);
    expect(hasGeometryPayload(result)).toBe(false);
    expect(JSON.stringify(result)).not.toContain('"lateOnly":42');
  });

  it("produces deterministic summaries and snapshots detached from the source state", () => {
    const input = state(collection({ type: "Point", coordinates: [0, 0] }));
    input.selection.featureIds = ["b", "a"];
    const result = semanticMapState(input);
    const reordered = { ...input, layers: input.layers.map((layer) => ({ ...layer, fields: [...layer.fields].reverse() })), selection: { featureIds: ["a", "b"] } };
    expect(JSON.stringify(semanticMapState(reordered))).toBe(JSON.stringify(result));
    input.viewport.bbox[0] = -10;
    input.layers[0]!.fields[0]!.name = "modified";
    expect(result.viewport.bbox[0]).toBe(-2);
    expect(result.layers[0]?.fields.some((field) => field.name === "modified")).toBe(false);
  });

  it("is much smaller than raw GeoJSON and its size does not scale with feature coordinates", () => {
    const small = collection({ type: "Point", coordinates: [-0.1, 51.5] }, 100);
    const large = collection({ type: "Point", coordinates: [-0.1, 51.5] }, 10_000);
    const smallContext = JSON.stringify(semanticMapState(state(small)));
    const largeContext = JSON.stringify(semanticMapState(state(large)));
    expect(largeContext.length).toBeLessThan(JSON.stringify(large).length / 100);
    expect(largeContext.length - smallContext.length).toBeLessThan(20);
    expect(hasGeometryPayload(JSON.parse(largeContext))).toBe(false);
  });

  it("allows explicit layer-scoped geometry-derived metrics while excluding GeoJSON", () => {
    const input = state(collection({ type: "LineString", coordinates: [[0, 0], [1, 1]] }));
    const result = semanticMapState(input, { geometrySummaries: [{ layerId: "source", purpose: "Evaluate road lengths", metrics: { lengthMeters: 157249, crossesSelection: false } }] });
    expect(result.geometrySummaries).toEqual([{ layerId: "source", purpose: "Evaluate road lengths", metrics: { crossesSelection: false, lengthMeters: 157249 } }]);
    expect(hasGeometryPayload(result)).toBe(false);
    expect(() => semanticMapState(input, { geometrySummaries: [{ layerId: "unknown", purpose: "Lengths", metrics: {} }] })).toThrow(/Unknown/);
    expect(() => semanticMapState(input, { geometrySummaries: [{ layerId: "source", purpose: "", metrics: {} }] })).toThrow(/purpose/);
    expect(() => semanticMapState(input, { geometrySummaries: [{ layerId: "source", purpose: "Invalid", metrics: { lengthMeters: Number.NaN } }] })).toThrow(/finite/);
    expect(() => semanticMapState(input, { geometrySummaries: [{ layerId: "source", purpose: "Forbidden payload", metrics: { raw: input.layers[0]!.sample } as never }] })).toThrow(/GeoJSON/);
  });
});
