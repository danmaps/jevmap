import { describe, expect, it, vi } from "vitest";
import {
  createSpatialDecisionPlan, prepareSpatialDecision, executeSpatialDecision, spatialDecisionReceipt,
} from "../src/analysis/workflow.js";
import { KEEP_CURRENT_OPTION_ID } from "../src/decisions/index.js";
import type { DecisionClient } from "../src/jev/providers.js";
import type { SystemOneRequest } from "../src/jev/index.js";
import { summarizeFeatureCollection, type JevMapState } from "../src/state/index.js";
import type { SpatialData, WorkbenchContext } from "../src/workbench/index.js";

function points(count = 2): SpatialData {
  return {
    type: "FeatureCollection",
    features: Array.from({ length: count }, (_, index) => ({
      type: "Feature", id: "feature-" + index, properties: { kind: index % 2 ? "park" : "school" },
      geometry: { type: "Point", coordinates: [index * 0.001, 0] },
    })),
  };
}

function setup(data = points(), others: Array<[string, SpatialData]> = []): { state: JevMapState; context: WorkbenchContext } {
  const entries: Array<[string, SpatialData]> = [["source", data], ...others];
  return {
    state: {
      intent: "Apply the requested spatial operation", viewport: { bbox: [-1, -1, 1, 1], zoom: 10 },
      layers: entries.map(([id, collection]) => summarizeFeatureCollection(id, id, collection)),
      selection: { featureIds: [] }, previousActions: [],
    },
    context: { layers: new Map(entries) },
  };
}

interface ClientOptions {
  action?: string;
  actionProbabilities?: Record<string, number>;
  confidence?: number;
  fieldChoice?: Record<string, string>;
  missingAnswer?: string;
  orderedProbabilities?: Record<string, number>;
  orderedChoice?: string;
  orderedConfidence?: number;
  keep?: boolean;
}

function fakeClient(options: ClientOptions = {}) {
  const requests: Array<{ state: SystemOneRequest["state"]; questions: SystemOneRequest["questions"] }> = [];
  const ask = vi.fn<DecisionClient["ask"]>(async (state, questions) => {
    requests.push({ state, questions });
    const answers = Object.fromEntries(Object.entries(questions).filter(([name]) => name !== options.missingAnswer).map(([name, question]) => {
      if (question.type !== "choice") throw new Error("Tests expect bounded choices.");
      const keys = Object.keys(question.criteria);
      const preferred = name === "action" ? options.action ?? "buffer" : name === "distance" ? options.orderedChoice ?? "250m" : name === "selection" ? "all" : options.fieldChoice?.[name] ?? keys[0]!;
      const choice = options.keep && keys.includes(KEEP_CURRENT_OPTION_ID) ? KEEP_CURRENT_OPTION_ID : options.fieldChoice?.[name] ?? preferred;
      const confidence = name === "distance" ? options.orderedConfidence ?? (keys.length === 1 ? 1 : 0.9) : name === "action" ? options.confidence ?? (keys.length === 1 ? 1 : 0.9) : keys.length === 1 ? 1 : 0.9;
      const distribution = name === "action" ? options.actionProbabilities : name === "distance" ? options.orderedProbabilities : undefined;
      const probabilities = distribution
        ? Object.fromEntries(keys.map((key) => [key, distribution[key] ?? 0]))
        : Object.fromEntries(keys.map((key) => [key, key === choice ? (keys.length === 1 ? 1 : confidence) : (1 - confidence) / (keys.length - 1)]));
      return [name, { type: "choice", choice, confidence, probabilities }];
    }));
    return { model: "test-jev", answers: answers as never, usage: { input_tokens: 10, output_tokens: 5 } };
  });
  return { ask, requests };
}

function containsRawGeometry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const object = value as Record<string, unknown>;
  return Object.hasOwn(object, "coordinates") || Object.hasOwn(object, "features") || Object.hasOwn(object, "sample") || object.type === "FeatureCollection" || Object.values(object).some(containsRawGeometry);
}

describe("spatial decision surface integration", () => {
  it("stages bounded operation and parameter decisions against geometry-free context", async () => {
    const { state, context } = setup(points(100));
    const client = fakeClient();
    const plan = await createSpatialDecisionPlan(state, client, context);
    expect(client.requests.map((request) => Object.keys(request.questions))).toEqual([["action"], ["layer", "distance"]]);
    expect(client.requests.every((request) => !containsRawGeometry(request.state))).toBe(true);
    expect(plan.call).toEqual({ tool: "buffer", args: { layerId: "source", distanceMeters: 250 } });
    expect(plan.policy).toBe("execute");
    expect(plan.decisions.action.policy.kind).toBe("winner");
    expect(plan.decisions.layer.policy.kind).toBe("winner");
    expect(plan.decisions.distance.policy.kind).toBe("ordered");
    expect(plan.stateDiff).toEqual({ action: "buffer", layer: "source", distance: 250 });
    const receipt = spatialDecisionReceipt(plan);
    expect(receipt.semanticContext).toEqual(plan.semanticContext);
    expect(receipt.decisions).toEqual(plan.decisions);
    expect(receipt.decisionPayloads).toHaveLength(2);
    expect(receipt.modelResponses).toHaveLength(2);
    expect(receipt.stateHash).toBeTruthy();
    expect(receipt.runtimeHash).toBe(plan.runtimeHash);
    expect(receipt.executionStateHash).toBe(plan.executionStateHash);
    expect(receipt.inference).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  });

  it("derives model metadata from authoritative geometry instead of stale layer summaries", async () => {
    const { state, context } = setup();
    state.layers[0]!.geometryType = "Polygon";
    state.layers[0]!.summary.geometryTypes = ["Polygon"];
    state.layers[0]!.featureCount = 999;
    const client = fakeClient();
    const plan = await createSpatialDecisionPlan(state, client, context);
    expect(plan.semanticContext.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "source", geometryType: "Point", geometryTypes: ["Point"], featureCount: 2 }),
    ]));
    expect(client.requests[0]!.state).toMatchObject({ layers: [expect.objectContaining({ id: "source", featureCount: 2 })] });
  });

  it("applies ordered distance evidence separately from reported probability and confidence", async () => {
    const { state, context } = setup();
    const client = fakeClient({ orderedChoice: "250m", orderedConfidence: 0.38, orderedProbabilities: { "25m": 0, "50m": 0, "100m": 0.1, "250m": 0.38, "500m": 0.43, "1km": 0.09 } });
    const plan = await createSpatialDecisionPlan(state, client, context);
    expect(plan.call).toEqual({ tool: "buffer", args: { layerId: "source", distanceMeters: 500 } });
    expect(plan.decisions.distance).toMatchObject({ disposition: "apply", confidence: 0.38, effectiveConfidence: 0.9, selectedOptionId: "500m", provenance: { reportedOptionId: "250m" } });
    expect(plan.decisions.distance.probabilities["500m"]).toBe(0.43);
    expect(plan.policy).toBe("execute");
  });

  it("preserves typed current values and keeps no-op fields out of stateDiff", async () => {
    const { state, context } = setup();
    const plan = await createSpatialDecisionPlan(state, fakeClient({ keep: true }), context, { action: "buffer", layer: "source", distance: 250 });
    expect(Object.values(plan.decisions).map((field) => field.disposition)).toEqual(["keep", "keep", "keep"]);
    expect(plan.stateDiff).toEqual({});
    expect(plan.decisions.distance.selectedValue).toBe(250);
    expect(plan.policy).toBe("execute");
  });

  it("does not let a kept operation bypass execution confidence or ambiguity policy", async () => {
    const { state, context } = setup();
    for (const options of [
      { keep: true, confidence: 0.4 },
      { confidence: 0.4 },
      { keep: true, confidence: 0.9, actionProbabilities: { buffer: 0.5, [KEEP_CURRENT_OPTION_ID]: 0.5 } },
    ]) {
      const plan = await createSpatialDecisionPlan(state, fakeClient(options), context, { action: "buffer", layer: "source", distance: 250 });
      expect(plan.decisions.action.disposition).toBe("keep");
      expect(plan.stateDiff.action).toBeUndefined();
      expect(["clarify", "review"]).toContain(plan.policy);
      const held = await executeSpatialDecision(plan, state, context);
      expect(held.result).toBeUndefined();
      expect(["not-run", "pending"]).toContain(held.receipt.execution.status);
    }
  });

  it("keeps large selection current-value context bounded when requesting another selection", async () => {
    const { state, context } = setup(points(1000));
    const ids = context.layers.get("source")!.features.map((feature) => String(feature.id));
    state.selection = { layerId: "source", featureIds: ids };
    const client = fakeClient({ action: "select", keep: true });
    await createSpatialDecisionPlan(state, client, context, { selection: ids });
    const request = client.requests.find((item) => Object.hasOwn(item.questions, "selection"));
    expect(request).toBeDefined();
    expect(JSON.stringify(request!.state).length).toBeLessThan(10_000);
    expect(containsRawGeometry(request!.state)).toBe(false);
  });

  it("exposes only eligible geometry layers and rejects model-added layer IDs", async () => {
    const empty: SpatialData = { type: "FeatureCollection", features: [] };
    const { state, context } = setup(points(), [["empty", empty]]);
    const client = fakeClient();
    await createSpatialDecisionPlan(state, client, context);
    const layerQuestion = client.requests.find((item) => Object.hasOwn(item.questions, "layer"))!.questions.layer;
    expect(layerQuestion.type).toBe("choice");
    if (layerQuestion.type === "choice") expect(Object.keys(layerQuestion.criteria)).toEqual(["source"]);
    const invalid = await createSpatialDecisionPlan(state, fakeClient({ fieldChoice: { layer: "model-created-layer" } }), context);
    expect(invalid.decisions.layer.disposition).toBe("reject");
    expect(invalid.policy).toBe("reject");
    const result = await executeSpatialDecision(invalid, state, context, { approved: true });
    expect(result.result).toBeUndefined();
    expect(result.receipt.execution.status).toBe("not-run");
  });

  it("blocks missing answers, unavailable operations and confidence clarification even with approval", async () => {
    const { state, context } = setup();
    for (const options of [{ missingAnswer: "distance" }, { action: "delete" }, { confidence: 0.4 }]) {
      const plan = await createSpatialDecisionPlan(state, fakeClient(options), context);
      expect(["reject", "clarify"]).toContain(plan.policy);
      const executed = await executeSpatialDecision(plan, state, context, { approved: true });
      expect(executed.result).toBeUndefined();
      expect(executed.receipt.execution.status).toBe("not-run");
      expect(executed.receipt.execution.success).toBe(false);
      expect(executed.receipt.execution.error).toBeTruthy();
    }
  });

  it("holds reviewed calls until approval of the concrete call", async () => {
    const { state, context } = setup();
    const plan = await createSpatialDecisionPlan(state, fakeClient({ confidence: 0.7 }), context);
    const held = await executeSpatialDecision(plan, state, context);
    expect(held.plan.policy).toBe("review");
    expect(held.result).toBeUndefined();
    expect(held.receipt.execution.status).toBe("pending");
    const executed = await executeSpatialDecision(held.plan, state, context, { approved: true, receipt: held.receipt });
    expect(executed.result?.tool).toBe("buffer");
    expect(executed.receipt.execution.status).toBe("succeeded");
    expect(executed.receipt.id).toBe(held.receipt.id);
    expect(executed.receipt.stateDiff?.action).toBe("buffer");
  }, 15_000); // First real Turf import can exceed 5 s on a cold/contended filesystem.
});

describe("deterministic pre-execution guards", () => {
  it("detaches successful array-valued receipt diffs from the executed plan", async () => {
    const { state, context } = setup();
    const result = await executeSpatialDecision(await createSpatialDecisionPlan(state, fakeClient({ action: "select" }), context), state, context);
    (result.plan.decisions.selection.selectedValue as string[]).push("unavailable");
    expect(result.receipt.stateDiff?.selection).toEqual(["feature-0", "feature-1"]);
    expect(result.receipt.call).toEqual({ tool: "select", args: { layerId: "source", featureIds: ["feature-0", "feature-1"] } });
  });

  it("rejects approval receipts from another concrete plan", async () => {
    const { state, context } = setup();
    const first = await prepareSpatialDecision(await createSpatialDecisionPlan(state, fakeClient({ confidence: 0.7 }), context), state, context);
    const receipt = spatialDecisionReceipt(first);
    const second = await prepareSpatialDecision(await createSpatialDecisionPlan(state, fakeClient({ action: "export", confidence: 0.7 }), context), state, context);
    const result = await executeSpatialDecision(second, state, context, { approved: true, receipt });
    expect(result.result).toBeUndefined();
    expect(result.receipt.id).not.toBe(receipt.id);
    expect(result.receipt.guard?.rejected.at(-1)?.reason).toContain("Approval receipt");
  });

  it("does not rewrite historical receipts through mutable plan references", async () => {
    const { state, context } = setup();
    const plan = await createSpatialDecisionPlan(state, fakeClient(), context);
    const receipt = spatialDecisionReceipt(plan);
    plan.decisions.distance.selectedValue = 100_000;
    plan.decisionPayloads[0]!.model = "fabricated";
    expect(receipt.decisions?.distance.selectedValue).toBe(250);
    expect(receipt.decisionPayloads?.[0]?.model).toBe("jev-latest");
  });

  it("invalidates approval when runtime limits, capabilities, active results or history change", async () => {
    for (const change of ["limits", "capabilities", "active-results", "history"] as const) {
      const { state, context } = setup();
      const plan = await createSpatialDecisionPlan(state, fakeClient({ confidence: 0.7 }), context);
      if (change === "limits") context.maxFeatures = 1;
      else if (change === "capabilities") context.capabilities = new Map([["source", ["export"]]]);
      else if (change === "active-results") state.activeResultLayerIds = ["source"];
      else state.previousActions.push({ id: "new-result", selectedAction: "select", confidence: 1, success: true });
      const result = await executeSpatialDecision(plan, state, context, { approved: true });
      expect(result.result).toBeUndefined();
      expect(result.receipt.guard?.fallback).toBe(false);
      expect(result.receipt.guard?.rejected[0]?.reason).toContain("stale");
    }
  });

  it("catches runtime edits made while the complete-data digest is in flight", async () => {
    const { state, context } = setup(points(30));
    const plan = await createSpatialDecisionPlan(state, fakeClient(), context);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let calls = 0;
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      if (++calls === 3) context.layers.get("source")!.features[29]!.properties!.kind = "edited";
      return digest(...args);
    });
    try {
      const result = await executeSpatialDecision(plan, state, context, { approved: true });
      expect(result.result).toBeUndefined();
      expect(result.receipt.execution.status).toBe("not-run");
    } finally { spy.mockRestore(); }
  });

  it("enforces explicit layer capabilities when generating legal choices", async () => {
    const { state, context } = setup();
    state.layers[0]!.capabilities = ["export"];
    const client = fakeClient({ action: "export" });
    const plan = await createSpatialDecisionPlan(state, client, context);
    const question = client.requests[0]!.questions.action;
    if (question.type !== "choice") throw new Error("Expected choice");
    expect(Object.keys(question.criteria)).toEqual(["export"]);
    expect((await executeSpatialDecision(plan, state, context)).result?.tool).toBe("export");
  });

  it("does not let a weak retained input layer authorize a new spatial effect", async () => {
    const { state, context } = setup();
    const base = fakeClient();
    const client: DecisionClient = { ask: async (state, questions) => {
      const response = await base.ask(state, questions);
      if (questions.layer) response.answers.layer = { type: "choice", choice: "__keep__", confidence: 0.1, probabilities: { source: 0.9, __keep__: 0.1 } };
      return response;
    } };
    const plan = await createSpatialDecisionPlan(state, client, context, { layer: "source" });
    expect(plan.decisions.layer.disposition).toBe("keep");
    expect(plan.policy).toBe("clarify");
    expect((await executeSpatialDecision(plan, state, context, { approved: true })).result).toBeUndefined();
  });

  it("blocks a call mutated while its binding digest is in flight", async () => {
    const { state, context } = setup();
    const plan = await createSpatialDecisionPlan(state, fakeClient(), context);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      if (plan.calls.buffer?.tool === "buffer") plan.calls.buffer.args.distanceMeters = 100_000;
      return digest(...args);
    });
    try {
      const result = await executeSpatialDecision(plan, state, context, { approved: true });
      expect(result.result).toBeUndefined();
      expect(result.receipt.execution.success).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("revalidates the highest-ranked choice and records a reviewed, lower-ranked valid fallback", async () => {
    const { state, context } = setup(points(2), [["target", points(2)]]);
    context.maxPairComparisons = 1;
    const plan = await createSpatialDecisionPlan(state, fakeClient({
      action: "nearest", confidence: 0.85, actionProbabilities: { nearest: 0.85, select: 0.15 },
      fieldChoice: { layer: "source", overlay: "target" },
    }), context);
    const checked = await prepareSpatialDecision(plan, state, context);
    expect(checked.guard).toMatchObject({ originalChoice: "nearest", finalChoice: "select", fallback: true });
    expect(checked.guard?.rejected[0]).toMatchObject({ id: "nearest", reason: expect.stringMatching(/comparison limit/) });
    expect(checked.guard?.ranking.slice(0, 2)).toEqual([{ id: "nearest", probability: 0.85 }, { id: "select", probability: 0.15 }]);
    expect(checked.call?.tool).toBe("select");
    expect(checked.policy).toBe("review");
    expect(checked.stateDiff.action).toBeUndefined();
    expect(checked.decisions.action.probabilities.nearest).toBe(0.85);
    const tooEarly = await executeSpatialDecision(plan, state, context, { approved: true });
    expect(tooEarly.result).toBeUndefined();
    expect(tooEarly.receipt.execution.status).toBe("pending");
    const executed = await executeSpatialDecision(checked, state, context, { approved: true });
    expect(executed.result?.tool).toBe("select");
    expect(executed.receipt.selectedAction).toBe("select");
    expect(executed.receipt.stateDiff?.action).toBe("select");
    expect(executed.receipt.stateDiff?.overlay).toBeUndefined();
    expect(executed.receipt.stateDiff?.selection).toEqual(["feature-0", "feature-1"]);
    expect(executed.receipt.guard?.originalChoice).toBe("nearest");
  });

  it("records actionable guard reasons when no fallback has sufficient probability", async () => {
    const { state, context } = setup(points(2), [["target", points(2)]]);
    context.maxPairComparisons = 1;
    const plan = await createSpatialDecisionPlan(state, fakeClient({
      action: "nearest", confidence: 1, actionProbabilities: { nearest: 1 },
      fieldChoice: { layer: "source", overlay: "target" },
    }), context);
    const result = await executeSpatialDecision(plan, state, context, { approved: true });
    expect(result.result).toBeUndefined();
    expect(result.plan.policy).toBe("reject");
    expect(result.receipt.guard?.rejected).toContainEqual({ id: "nearest", reason: "Pairwise analysis exceeds the browser comparison limit. Reduce the layers first." });
    expect(result.receipt.validation.warnings.some((warning) => warning.includes("comparison limit"))).toBe(true);
    expect(result.receipt.execution.error).toBeTruthy();
    expect(result.receipt.execution.status).toBe("not-run");
  });

  it("rejects a changed but individually valid parameter instead of executing or falling back", async () => {
    const { state, context } = setup();
    const plan = await createSpatialDecisionPlan(state, fakeClient(), context);
    expect(plan.decisions.distance.selectedValue).toBe(250);
    if (plan.calls.buffer?.tool !== "buffer") throw new Error("Expected a buffer call.");
    plan.calls.buffer.args.distanceMeters = 100_000;
    const result = await executeSpatialDecision(plan, state, context, { approved: true });
    expect(Boolean(result.result)).toBe(false);
    expect(result.plan.policy).toBe("reject");
    expect(result.plan.call).toBeUndefined();
    expect(result.receipt.execution.status).toBe("not-run");
    expect(result.receipt.guard?.fallback).toBe(false);
    expect(result.receipt.guard?.rejected[0]?.reason).toMatch(/changed|binding|modified/i);
    expect(result.receipt.decisions?.distance.selectedValue).toBe(250);
  });

  it("rejects changed canonical field values even when the original call is still valid", async () => {
    const { state, context } = setup();
    const plan = await createSpatialDecisionPlan(state, fakeClient(), context);
    plan.decisions.distance.selectedValue = 100_000;
    const result = await executeSpatialDecision(plan, state, context, { approved: true });
    expect(Boolean(result.result)).toBe(false);
    expect(result.plan.policy).toBe("reject");
    expect(result.receipt.execution.status).toBe("not-run");
    expect(result.receipt.guard?.rejected[0]?.reason).toMatch(/changed|binding|modified/i);
  });

  it("rebuilds a tampered derived stateDiff from bound choices before recording execution", async () => {
    const { state, context } = setup();
    const plan = await createSpatialDecisionPlan(state, fakeClient(), context);
    expect(plan.bindingHash).toBeTruthy();
    plan.stateDiff.distance = 100_000;
    const result = await executeSpatialDecision(plan, state, context);
    expect(result.result?.tool).toBe("buffer");
    expect(result.receipt.execution.status).toBe("succeeded");
    expect(result.receipt.bindingHash).toBe(plan.bindingHash);
    expect(result.receipt.decisions?.distance.selectedValue).toBe(250);
    expect(result.receipt.call).toEqual({ tool: "buffer", args: { layerId: "source", distanceMeters: 250 } });
    expect(result.receipt.stateDiff?.distance).toBe(250);
  });

  it("preserves canonical review when the mutable execution policy is relaxed", async () => {
    const { state, context } = setup();
    const plan = await createSpatialDecisionPlan(state, fakeClient({ confidence: 0.7 }), context);
    expect(plan.policy).toBe("review");
    plan.policy = "execute";
    const held = await executeSpatialDecision(plan, state, context);
    expect(Boolean(held.result)).toBe(false);
    expect(held.plan.policy).toBe("review");
    expect(held.receipt.execution.status).toBe("pending");
    const approved = await executeSpatialDecision(held.plan, state, context, { approved: true, receipt: held.receipt });
    expect(approved.result?.tool).toBe("buffer");
    expect(approved.receipt.execution.status).toBe("succeeded");
  });

  it("rejects resource limits and can propose a legal export fallback", async () => {
    const { state, context } = setup(points(3));
    context.maxFeatures = 1;
    const plan = await createSpatialDecisionPlan(state, fakeClient({ confidence: 0.65, actionProbabilities: { buffer: 0.65, select: 0.2, export: 0.15 } }), context);
    const checked = await prepareSpatialDecision(plan, state, context);
    expect(checked.policy).toBe("review");
    expect(checked.call?.tool).toBe("export");
    expect(checked.guard?.rejected.slice(0, 2).map((item) => item.id)).toEqual(["buffer", "select"]);
    expect(checked.guard?.rejected[0]?.reason).toMatch(/feature limit/);
  });

  it("detects edits beyond the sampled geometry before approval can execute", async () => {
    const data = points(30);
    const { state, context } = setup(data);
    const plan = await createSpatialDecisionPlan(state, fakeClient(), context);
    expect(state.layers[0]?.sample?.features).toHaveLength(25);
    data.features[29]!.geometry = { type: "Point", coordinates: [20, 20] };
    const result = await executeSpatialDecision(plan, state, context, { approved: true });
    expect(result.result).toBeUndefined();
    expect(result.plan.policy).toBe("reject");
    expect(result.receipt.guard?.rejected[0]?.reason).toMatch(/stale/);
    expect(result.receipt.execution.status).toBe("not-run");
  });

  it("detects changes to fields, selections and runtime layer availability", async () => {
    for (const change of ["property", "selection", "missing-layer"] as const) {
      const data = points(30);
      const { state, context } = setup(data);
      const plan = await createSpatialDecisionPlan(state, fakeClient(), context);
      if (change === "property") data.features[29]!.properties!.kind = "modified";
      if (change === "selection") state.selection.featureIds.push("feature-0");
      const changedContext = change === "missing-layer" ? { layers: new Map<string, SpatialData>() } : context;
      const result = await executeSpatialDecision(plan, state, changedContext, { approved: true });
      expect(result.result).toBeUndefined();
      expect(result.plan.policy).toBe("reject");
      expect(result.receipt.guard?.rejected[0]?.reason).toMatch(/stale/);
    }
  });

  it("allows viewport movement without invalidating the underlying approved GIS inputs", async () => {
    const { state, context } = setup();
    const plan = await createSpatialDecisionPlan(state, fakeClient(), context);
    state.viewport = { bbox: [0, 0, 5, 5], zoom: 7 };
    expect((await executeSpatialDecision(plan, state, context)).result?.tool).toBe("buffer");
  });
});

describe("bounded primary workflow tool paths", () => {
  it("can filter a field introduced after the geometry and schema sample boundaries", async () => {
    const data = points(150);
    data.features[149]!.properties!.lateOnly = 42;
    const { state, context } = setup(data);
    const client = fakeClient({ action: "filter", fieldChoice: { layer: "source", predicate: "predicate-2" } });
    const plan = await createSpatialDecisionPlan(state, client, context);
    expect(plan.semanticContext.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ fields: expect.arrayContaining([{ name: "lateOnly", type: "number" }]) }),
    ]));
    expect(plan.call).toEqual({ tool: "filter", args: { layerId: "source", field: "lateOnly", value: 42 } });
    const result = await executeSpatialDecision(plan, state, context);
    expect(result.result?.data.features.map((feature) => feature.id)).toEqual(["feature-149"]);
    expect(result.receipt.execution.status).toBe("succeeded");
  });

  const polygon: SpatialData = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]] } }] };
  it.each(["buffer", "intersect", "nearest", "filter", "select", "export"] as const)("executes %s through validated staged choices and inspectable receipts", async (action) => {
    const others: Array<[string, SpatialData]> = action === "intersect" ? [["target", polygon]] : action === "nearest" ? [["target", points(1)]] : [];
    const { state, context } = setup(points(2), others);
    const fieldChoice = { layer: "source", overlay: "target", ...(action === "select" ? { selection: "id-0" } : {}) };
    const plan = await createSpatialDecisionPlan(state, fakeClient({ action, fieldChoice }), context);
    const result = await executeSpatialDecision(plan, state, context);
    expect(result.result?.tool).toBe(action);
    expect(result.receipt.execution.status).toBe("succeeded");
    expect(result.receipt.validation.valid).toBe(true);
    expect(result.receipt.call?.tool).toBe(action);
    expect(result.receipt.guard?.finalChoice).toBe(action);
    expect(result.receipt.semanticContext).toEqual(plan.semanticContext);
    expect(containsRawGeometry(result.receipt.semanticContext)).toBe(false);
    if (action === "nearest") expect(result.result?.data.features[0]?.geometry.type).toBe("LineString");
    if (action === "select" || action === "filter") expect(result.result?.data.features).toHaveLength(1);
  });
});
