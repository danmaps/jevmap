import { readFile, writeFile } from "node:fs/promises";
import { createDecisionClient } from "../src/jev/providers.js";
import { createSpatialDecisionPlan, prepareSpatialDecision, executeSpatialDecision, spatialDecisionReceipt } from "../src/analysis/workflow.js";
import { summarizeFeatureCollection, type JevMapState } from "../src/state/index.js";
import type { SpatialData } from "../src/workbench/index.js";

/** Real CPU workflow evidence, separate from fake-response regression tests. */
export async function reproduceReview(output: string) {
  const client = createDecisionClient("julia", { juliaEndpoint: process.env.JULIA_EVALUATION_ENDPOINT ?? "http://127.0.0.1:8765/api/julia" });
  const browserReceipt = JSON.parse(await readFile("docs/review/nearest-browser-before.json", "utf8"));
  const points: SpatialData = JSON.parse(await readFile("public/demo/los-angeles-points.geojson", "utf8"));
  const landmarks: SpatialData = { type: "FeatureCollection", features: [
    { type: "Feature", properties: { name: "Civic landmark", kind: "civic" }, geometry: { type: "Point", coordinates: [-118.243, 34.053] } },
    { type: "Feature", properties: { name: "Park landmark", kind: "park" }, geometry: { type: "Point", coordinates: [-118.29, 34.09] } },
    { type: "Feature", properties: { name: "Transit landmark", kind: "transit" }, geometry: { type: "Point", coordinates: [-118.265, 34.04] } },
  ] };
  const nearestEntries: Array<[string, string, SpatialData]> = [["la-demo-points", "Los Angeles demo points", points], ["la-landmarks", "Synthetic landmarks", landmarks]];
  const schoolEntries: Array<[string, string, SpatialData]> = [["schools", "Schools", points]];
  const cases = [];
  for (const [id, intent, entries] of [
    ["nearest-direction", browserReceipt.question, nearestEntries],
    ["ambiguous-operation", "Make the map more useful.", schoolEntries],
    ["ambiguous-distance", "Show the area around the schools. No distance is specified.", schoolEntries],
  ] as Array<[string, string, Array<[string, string, SpatialData]>]>) {
    const state: JevMapState = { intent, viewport: browserReceipt.semanticContext.viewport,
      layers: entries.map(([id, name, data]) => summarizeFeatureCollection(id, name, data)), selection: { featureIds: [] }, previousActions: [] };
    const context = { layers: new Map(entries.map(([id, , data]) => [id, data])) };
    const proposal = await createSpatialDecisionPlan(state, client, context);
    const prepared = await prepareSpatialDecision(proposal, state, context);
    const pending = spatialDecisionReceipt(prepared);
    const unapproved = await executeSpatialDecision(prepared, state, context, { receipt: pending });
    // This explicit test approval measures deterministic output; it is not an assertion that the interpretation is correct.
    const approved = await executeSpatialDecision(prepared, state, context, { approved: true, receipt: pending });
    const stale = await executeSpatialDecision(prepared, { ...state, intent: "Export instead." }, context, { approved: true, receipt: pending });
    cases.push({ id, expectedInput: id === "nearest-direction" ? "la-demo-points" : null,
      directionCorrect: id === "nearest-direction" ? prepared.call?.args.layerId === "la-demo-points" : null,
      blockedWithoutApproval: !unapproved.result, staleApprovalBlocked: !stale.result,
      unapproved: unapproved.receipt, approved: approved.receipt, stale: stale.receipt,
      outputFeatureCount: approved.result?.data.features.length ?? null,
      output: approved.result?.data ?? null });
  }
  const report = { timestamp: new Date().toISOString(), protocol: "Production Julia adapter and full staged workflow. Nearest uses the exact captured browser viewport, demo source features and synthetic targets. Ambiguous full workflows use the same viewport and eight synthetic school points. Each concrete call is held, explicitly test-approved, and rejected with a changed goal. Approval does not certify semantic correctness. No Jev endpoint was configured.", cases };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, cases: cases.map(({ id, directionCorrect, blockedWithoutApproval, staleApprovalBlocked, outputFeatureCount, approved }) => ({ id, directionCorrect, blockedWithoutApproval, staleApprovalBlocked, outputFeatureCount, call: approved.call, fieldDispositions: Object.fromEntries(Object.entries(approved.decisions ?? {}).map(([id, field]) => [id, field.disposition])) })) }, null, 2));
}
