import { area, booleanPointInPolygon, point } from "@turf/turf";
import { describe, expect, it } from "vitest";
import { executeWorkbenchCall, validateWorkbenchCall, WORKBENCH_REGISTRY, type SpatialData, type WorkbenchCall, type WorkbenchContext } from "../src/workbench/index.js";

const points: SpatialData = { type: "FeatureCollection", features: [
  { type: "Feature", id: "school-a", properties: { name: "School A", kind: "school", count: 1, active: true, nullable: null }, geometry: { type: "Point", coordinates: [0, 0] } },
  { type: "Feature", id: 7, properties: { name: "Outside", kind: "residential", count: "1", active: false }, geometry: { type: "Point", coordinates: [.02, .02] } },
  { type: "Feature", properties: { name: "School C", kind: "school", active: true }, geometry: { type: "Point", coordinates: [.001, 0] } },
] };
const origin: SpatialData = { type: "FeatureCollection", features: [points.features[0]!] };
const overlay: SpatialData = { type: "FeatureCollection", features: [
  { type: "Feature", properties: { name: "Study area" }, geometry: { type: "Polygon", coordinates: [[[-.01, -.01], [.01, -.01], [.01, .01], [-.01, .01], [-.01, -.01]]] } },
] };
const targets: SpatialData = { type: "FeatureCollection", features: [
  { type: "Feature", id: "east", properties: { name: "East" }, geometry: { type: "Point", coordinates: [.01, 0] } },
  { type: "Feature", id: "west", properties: { name: "West" }, geometry: { type: "Point", coordinates: [-.01, 0] } },
] };
const lines: SpatialData = { type: "FeatureCollection", features: [
  { type: "Feature", id: "crossing", properties: { name: "Crosses study area" }, geometry: { type: "LineString", coordinates: [[-.02, 0], [.02, 0]] } },
  { type: "Feature", id: "outside", properties: { name: "Outside study area" }, geometry: { type: "LineString", coordinates: [[.02, .02], [.03, .03]] } },
] };
const empty: SpatialData = { type: "FeatureCollection", features: [] };

function context(patch: Partial<WorkbenchContext> = {}): WorkbenchContext {
  return { layers: new Map([['points', points], ['origin', origin], ['overlay', overlay], ['targets', targets], ['lines', lines], ['empty', empty]]), ...patch };
}
const calls: Record<WorkbenchCall['tool'], WorkbenchCall> = {
  buffer: { tool: "buffer", args: { layerId: "points", distanceMeters: 100 } },
  intersect: { tool: "intersect", args: { layerId: "points", overlayLayerId: "overlay" } },
  nearest: { tool: "nearest", args: { layerId: "points", targetLayerId: "targets" } },
  filter: { tool: "filter", args: { layerId: "points", field: "kind", value: "school" } },
  select: { tool: "select", args: { layerId: "points", featureIds: ["school-a"] } },
  export: { tool: "export", args: { layerId: "points", format: "geojson" } },
};
function invalidCall(value: unknown): WorkbenchCall { return value as WorkbenchCall; }

describe("deterministic spatial workbench", () => {
  it("implements all six registered tools with concrete geometry or serialization results", () => {
    expect(WORKBENCH_REGISTRY.map((tool) => tool.id)).toEqual(["buffer", "intersect", "nearest", "filter", "select", "export"]);
    expect(WORKBENCH_REGISTRY.every((tool) => tool.status === "implemented")).toBe(true);
  });

  it("creates a metric 100 m buffer containing nearby points and excluding distant points", async () => {
    const result = await executeWorkbenchCall({ tool: "buffer", args: { layerId: "origin", distanceMeters: 100 } }, context());
    expect(result.layerId).toBe("origin__buffer_100m");
    expect(result.data.features).toHaveLength(1);
    const polygon = result.data.features[0]!;
    expect(polygon.geometry.type).toBe("Polygon");
    expect(area(result.data)).toBeGreaterThan(30_000);
    expect(area(result.data)).toBeLessThan(32_000);
    expect(booleanPointInPolygon(point([.00045, 0]), polygon as never)).toBe(true);
    expect(booleanPointInPolygon(point([.00135, 0]), polygon as never)).toBe(false);
    expect(polygon.properties?.name).toBe("School A");
  });

  it("intersects points and crossing lines with a polygon while preserving the selected input geometry", async () => {
    const result = await executeWorkbenchCall(calls.intersect, context());
    expect(result.layerId).toBe("points__intersect");
    expect(result.data.features).toEqual([points.features[0], points.features[2]]);
    const crossing = await executeWorkbenchCall({ tool: "intersect", args: { layerId: "lines", overlayLayerId: "overlay" } }, context());
    expect(crossing.data.features).toEqual([lines.features[0]]);
    expect(crossing.data.features[0]?.geometry).toEqual(lines.features[0]?.geometry);
  });

  it("finds actual nearest points in meters and resolves equal distances in target order", async () => {
    const inputs: SpatialData = { type: "FeatureCollection", features: [points.features[0]!, { type: "Feature", properties: { name: "East input" }, geometry: { type: "Point", coordinates: [.019, 0] } }] };
    const result = await executeWorkbenchCall({ tool: "nearest", args: { layerId: "sources", targetLayerId: "targets" } }, context({ layers: new Map([['sources', inputs], ['targets', targets]]) }));
    expect(result.data.features.map((feature) => feature.geometry)).toEqual([
      { type: "LineString", coordinates: [[0, 0], [.01, 0]] },
      { type: "LineString", coordinates: [[.019, 0], [.01, 0]] },
    ]);
    expect(result.data.features[0]?.properties).toMatchObject({ name: "School A", nearest: "East" });
    expect(result.data.features[0]?.properties?.distanceMeters).toBeCloseTo(1111.9508, 1);
    expect(result.data.features[1]?.properties?.distanceMeters).toBeCloseTo(1000.7557, 1);
  });

  it.each([
    ["kind", "school", [0, 2]], ["count", 1, [0]], ["count", "1", [1]],
    ["active", false, [1]], ["nullable", null, [0]], ["kind", "absent", []],
  ] as const)("filters %s = %s by exact scalar equality", async (field, value, expectedIndices) => {
    const result = await executeWorkbenchCall({ tool: "filter", args: { layerId: "points", field, value } }, context());
    expect(result.data.features).toEqual(expectedIndices.map((index) => points.features[index]));
  });

  it("selects string, numeric, and generated IDs in source order and permits an empty selection", async () => {
    const result = await executeWorkbenchCall({ tool: "select", args: { layerId: "points", featureIds: ["feature-2", "school-a"] } }, context());
    expect(result.data.features).toEqual([points.features[0], points.features[2]]);
    const numeric = await executeWorkbenchCall({ tool: "select", args: { layerId: "points", featureIds: ["7"] } }, context());
    expect(numeric.data.features).toEqual([points.features[1]]);
    const noSelection = await executeWorkbenchCall({ tool: "select", args: { layerId: "points", featureIds: [] } }, context());
    expect(noSelection.data.features).toEqual([]);
  });

  it("exports the original GeoJSON content, including empty layers", async () => {
    const result = await executeWorkbenchCall(calls.export, context());
    expect(result).toEqual({ tool: "export", layerId: "points", data: points });
    expect(JSON.parse(JSON.stringify(result.data))).toEqual(points);
    const noFeatures = await executeWorkbenchCall({ tool: "export", args: { layerId: "empty" } }, context());
    expect(noFeatures.data).toEqual(empty);
  });

  it("does not mutate the source data through any operation", async () => {
    const before = structuredClone({ points, overlay, targets });
    for (const call of Object.values(calls)) await executeWorkbenchCall(call, context());
    expect({ points, overlay, targets }).toEqual(before);
  });
});

describe("workbench runtime guards", () => {
  it.each([
    [null, /Unknown workbench tool/],
    [{ tool: "eval", args: { layerId: "points", code: "arbitrary code" } }, /Unknown workbench tool/],
    [{ tool: "buffer" }, /requires a layer ID/],
    [{ tool: "buffer", args: [] }, /requires a layer ID/],
    [{ tool: "buffer", args: { layerId: "" } }, /requires a layer ID/],
    [{ tool: "buffer", args: { layerId: "missing", distanceMeters: 100 } }, /Unknown layer/],
    [{ tool: "buffer", args: { layerId: "points" } }, /Buffer distance/],
    [{ tool: "nearest", args: { layerId: "points" } }, /target or overlay layer ID/],
    [{ tool: "intersect", args: { layerId: "points", overlayLayerId: "missing" } }, /Unknown layer/],
    [{ tool: "filter", args: { layerId: "points", field: "missing", value: "school" } }, /Missing filter field/],
    [{ tool: "filter", args: { layerId: "points", field: "kind" } }, /scalar/],
    [{ tool: "filter", args: { layerId: "points", field: "kind", value: { code: "object" } } }, /scalar/],
    [{ tool: "select", args: { layerId: "points" } }, /unavailable feature ID/],
    [{ tool: "select", args: { layerId: "points", featureIds: ["not-in-layer"] } }, /unavailable feature ID/],
    [{ tool: "select", args: { layerId: "points", featureIds: [7] } }, /unavailable feature ID/],
    [{ tool: "select", args: { layerId: "points", featureIds: ["school-a", "school-a"] } }, /must be unique/],
    [{ tool: "export", args: { layerId: "points", format: "csv" } }, /Only GeoJSON/],
  ])("rejects invalid runtime calls before execution: %s", async (call, expectedError) => {
    expect(() => validateWorkbenchCall(invalidCall(call), context())).toThrow(expectedError);
    await expect(executeWorkbenchCall(invalidCall(call), context())).rejects.toThrow(expectedError);
  });

  it.each(Object.keys(calls) as WorkbenchCall['tool'][])("rejects unknown arguments for %s", (tool) => {
    const call = calls[tool];
    expect(() => validateWorkbenchCall(invalidCall({ ...call, args: { ...call.args, expression: "unsupported value" } }), context())).toThrow(/Unknown .* argument/);
  });

  it("rejects unknown top-level fields and non-plain argument objects", () => {
    expect(() => validateWorkbenchCall(invalidCall({ ...calls.buffer, execute: "unexpected" }), context())).toThrow(/unknown field/);
    const inheritedArgs = Object.create({ layerId: "points" }) as { distanceMeters: number };
    inheritedArgs.distanceMeters = 100;
    expect(() => validateWorkbenchCall(invalidCall({ tool: "buffer", args: inheritedArgs }), context())).toThrow(/requires a layer ID/);
  });

  it.each([0, -1, NaN, Infinity, 100_001])("rejects invalid buffer distance %s", (distanceMeters) => {
    expect(() => validateWorkbenchCall({ tool: "buffer", args: { layerId: "points", distanceMeters } }, context())).toThrow(/positive finite number/);
  });

  it("rejects a non-finite filter attribute value", () => {
    expect(() => validateWorkbenchCall({ tool: "filter", args: { layerId: "points", field: "count", value: NaN } }, context())).toThrow(/must be finite/);
  });

  it.each([
    [{ tool: "nearest", args: { layerId: "points", targetLayerId: "lines" } }, /Point geometry/],
    [{ tool: "intersect", args: { layerId: "points", overlayLayerId: "targets" } }, /polygon overlay/],
    [{ tool: "nearest", args: { layerId: "points", targetLayerId: "points" } }, /distinct layers/],
    [{ tool: "intersect", args: { layerId: "empty", overlayLayerId: "overlay" } }, /nonempty layers/],
    [{ tool: "buffer", args: { layerId: "empty", distanceMeters: 100 } }, /nonempty point/],
  ])("rejects incompatible geometry or layer combinations: %s", (call, expectedError) => {
    expect(() => validateWorkbenchCall(invalidCall(call), context())).toThrow(expectedError);
  });

  it.each(["buffer", "intersect", "nearest", "filter", "select"] as const)("enforces feature limits for %s", (tool) => {
    expect(() => validateWorkbenchCall(calls[tool], context({ maxFeatures: 2 }))).toThrow(/feature limit/);
  });

  it("enforces target feature and pair comparison limits at their actual boundary", () => {
    expect(() => validateWorkbenchCall(calls.nearest, context({ maxPairComparisons: 6 }))).not.toThrow();
    expect(() => validateWorkbenchCall(calls.nearest, context({ maxPairComparisons: 5 }))).toThrow(/comparison limit/);
    expect(() => validateWorkbenchCall({ tool: "nearest", args: { layerId: "origin", targetLayerId: "points" } }, context({ maxFeatures: 2 }))).toThrow(/comparison limit/);
  });

  it("uses UTF-8 byte limits for export and allows larger feature counts within that budget", () => {
    const unicode: SpatialData = { ...points, features: points.features.map((feature) => ({ ...feature, properties: { ...feature.properties, text: "é中文" } })) };
    const dataContext = context({ layers: new Map([['unicode', unicode]]), maxFeatures: 1 });
    const call: WorkbenchCall = { tool: "export", args: { layerId: "unicode" } };
    const bytes = new TextEncoder().encode(JSON.stringify(unicode)).byteLength;
    expect(bytes).toBeGreaterThan(JSON.stringify(unicode).length);
    expect(() => validateWorkbenchCall(call, { ...dataContext, maxExportBytes: bytes })).not.toThrow();
    expect(() => validateWorkbenchCall(call, { ...dataContext, maxExportBytes: bytes - 1 })).toThrow(/Export exceeds/);
  });

  it.each(["maxFeatures", "maxPairComparisons", "maxExportBytes"] as const)("rejects unsafe configured %s limits", (name) => {
    for (const value of [0, -1, NaN, Infinity, 1.5]) {
      expect(() => validateWorkbenchCall(calls.export, context({ [name]: value }))).toThrow(/positive finite integer/);
    }
  });

  it.each([
    { type: "Point", coordinates: [NaN, 0] },
    { type: "Point", coordinates: [[0, 0]] },
    { type: "LineString", coordinates: [[0, 0], [1, Infinity]] },
    { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, NaN], [0, 0]]] },
    { type: "MadeUpGeometry", coordinates: [0, 0] },
  ])("validates all coordinates and geometry types even for programmatic input: %s", (geometry) => {
    const data = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry }] } as unknown as SpatialData;
    expect(() => validateWorkbenchCall({ tool: "export", args: { layerId: "bad" } }, context({ layers: new Map([['bad', data]]) }))).toThrow(/supported type and finite coordinates/);
  });

  it.each([
    [{ type: "LineString", coordinates: [[0, 0]] }, /at least two positions/],
    [{ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1]]] }, /closed rings/],
    [{ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }, /closed rings/],
  ])("rejects structurally invalid lines and polygon rings before GIS execution: %s", (geometry, expectedError) => {
    const data = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry }] } as unknown as SpatialData;
    expect(() => validateWorkbenchCall({ tool: "buffer", args: { layerId: "bad", distanceMeters: 100 } }, context({ layers: new Map([['bad', data]]) }))).toThrow(expectedError);
  });

  it.each([
    [{ type: "Feature", properties: [], geometry: { type: "Point", coordinates: [0, 0] } }, /invalid GeoJSON feature/],
    [{ type: "Feature", id: { value: "bad-id" }, properties: {}, geometry: { type: "Point", coordinates: [0, 0] } }, /feature IDs/],
    [{ type: "Feature", id: NaN, properties: {}, geometry: { type: "Point", coordinates: [0, 0] } }, /feature IDs/],
  ])("rejects invalid feature attributes and IDs from programmatic input: %s", (feature, expectedError) => {
    const data = { type: "FeatureCollection", features: [feature] } as unknown as SpatialData;
    expect(() => validateWorkbenchCall({ tool: "export", args: { layerId: "bad" } }, context({ layers: new Map([['bad', data]]) }))).toThrow(expectedError);
  });
});
