import { buffer } from "@turf/turf";
import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";
import type { SpatialToolId } from "../candidates/index.js";

export interface SpatialToolDefinition {
  id: SpatialToolId;
  description: string;
  status: "implemented" | "planned";
}

export const WORKBENCH_REGISTRY: readonly SpatialToolDefinition[] = [
  { id: "buffer", description: "Create a metric buffer around features.", status: "implemented" },
  { id: "intersect", description: "Calculate shared geometry between layers.", status: "planned" },
  { id: "nearest", description: "Find nearest features between layers.", status: "planned" },
  { id: "filter", description: "Apply deterministic attribute filtering.", status: "planned" },
  { id: "select", description: "Select result features in the map runtime.", status: "planned" },
  { id: "export", description: "Serialize a result layer as GeoJSON.", status: "implemented" },
] as const;

export type BufferCall = {
  tool: "buffer";
  args: {
    layerId: string;
    distanceMeters: number;
  };
};

export type ExportCall = {
  tool: "export";
  args: {
    layerId: string;
  };
};

export type WorkbenchCall = BufferCall | ExportCall;

export interface WorkbenchContext {
  layers: ReadonlyMap<string, FeatureCollection<Geometry, GeoJsonProperties>>;
}

export interface WorkbenchResult {
  tool: WorkbenchCall["tool"];
  layerId: string;
  data: FeatureCollection<Geometry, GeoJsonProperties>;
}

export function validateWorkbenchCall(call: WorkbenchCall, context: WorkbenchContext): void {
  if (!context.layers.has(call.args.layerId)) {
    throw new Error(`Unknown layer: ${call.args.layerId}`);
  }

  if (call.tool === "buffer" && (!Number.isFinite(call.args.distanceMeters) || call.args.distanceMeters <= 0)) {
    throw new Error("Buffer distance must be a positive finite number.");
  }
}

export async function executeWorkbenchCall(
  call: WorkbenchCall,
  context: WorkbenchContext,
): Promise<WorkbenchResult> {
  validateWorkbenchCall(call, context);
  const input = context.layers.get(call.args.layerId);
  if (!input) throw new Error(`Unknown layer: ${call.args.layerId}`);

  if (call.tool === "export") {
    return { tool: call.tool, layerId: call.args.layerId, data: input };
  }

  const output = buffer(input, call.args.distanceMeters, { units: "meters" });
  if (!output) throw new Error("Buffer operation returned no geometry.");

  return {
    tool: call.tool,
    layerId: `${call.args.layerId}__buffer_${call.args.distanceMeters}m`,
    data: output as FeatureCollection<Geometry, GeoJsonProperties>,
  };
}
