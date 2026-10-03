import { describe, expect, it, vi } from "vitest";
import { createBufferDecisionPlan, executeBufferDecision, createPendingDecisionReceipt } from "../src/analysis/index.js";
import { applyDecisionPolicy, choiceQuestion } from "../src/jev/index.js";
import { JuliaClient, JULIA_MODEL, JULIA_REVISION, parseJuliaChoiceAnswer } from "../src/jev/julia-client.js";
import { createDecisionClient } from "../src/jev/providers.js";
import { summarizeFeatureCollection } from "../src/state/index.js";
import { createSpatialDecisionPlan, prepareSpatialDecision, executeSpatialDecision, spatialDecisionReceipt } from "../src/analysis/workflow.js";

const criteria = { "parks:west": "Western parks", "schools/east": "Eastern schools" };
const nativeAnswer = { type: "choice", choice: "schools/east", max_probability: 0.75, probabilities: { "parks:west": 0.25, "schools/east": 0.75 } };
const provenance = { backend: "julia", runtime: "python-cpu", model: JULIA_MODEL, version: JULIA_REVISION, simulated: false };
const response = (answers = { layer: nativeAnswer }) => new Response(JSON.stringify({ model: JULIA_MODEL, answers, provenance }), { headers: { "content-type": "application/json" } });

describe("Julia native choice adaptation", () => {
  it("preserves named IDs and full precision and uses max_probability as confidence", () => {
    expect(parseJuliaChoiceAnswer(nativeAnswer, "layer", criteria)).toEqual({ type: "choice", choice: "schools/east", confidence: 0.75, probabilities: nativeAnswer.probabilities });
    const precise = { type: "choice", choice: "schools/east", max_probability: 0.750000123, probabilities: { "parks:west": 0.249999877, "schools/east": 0.750000123 } };
    expect(parseJuliaChoiceAnswer(precise, "layer", criteria).confidence).toBe(0.750000123);
  });

  it.each([
    undefined,
    { ...nativeAnswer, type: "score" },
    { ...nativeAnswer, choice: "invented" },
    { ...nativeAnswer, max_probability: 1.5 },
    { ...nativeAnswer, probabilities: { "parks:west": 0.25 } },
    { ...nativeAnswer, probabilities: { "parks:west": 0.25, unknown: 0.75 } },
    { ...nativeAnswer, probabilities: { "parks:west": -0.1, "schools/east": 1.1 } },
    { ...nativeAnswer, probabilities: { "parks:west": 0.25, "schools/east": Number.NaN } },
    { ...nativeAnswer, probabilities: { "parks:west": 0.1, "schools/east": 0.75 } },
    { ...nativeAnswer, max_probability: 0.9 },
    { ...nativeAnswer, choice: "parks:west" },
  ])("rejects malformed, incomplete or inconsistent native outputs (%#)", (answer) => {
    expect(() => parseJuliaChoiceAnswer(answer, "layer", criteria)).toThrow();
  });

  it("routes low confidence through the shared clarification policy", () => {
    const answer = parseJuliaChoiceAnswer({ ...nativeAnswer, max_probability: 0.51, probabilities: { "parks:west": 0.49, "schools/east": 0.51 } }, "layer", criteria);
    expect(applyDecisionPolicy(answer.confidence)).toBe("clarify");
  });
});

describe("Julia requests", () => {
  it("calls the resident service with descriptions, returns provenance and no invented token usage", async () => {
    const fetchImpl = vi.fn(async () => response());
    const result = await new JuliaClient({ fetchImpl }).ask({ intent: "Schools" }, { layer: choiceQuestion("Choose the input", criteria) });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(request).toEqual({ state: { intent: "Schools" }, questions: { layer: { type: "choice", instructions: "Choose the input", criteria } } });
    expect(result.provenance).toEqual(provenance);
    expect(result.usageReported).toBe(false);
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/julia");
    expect(result.answerSources).toEqual({ layer: "model" });
  });

  it.each([2, 20])("supports the native %i-candidate boundary", async (count) => {
    const candidates = Object.fromEntries(Array.from({ length: count }, (_, index) => [`c-${index}`, `Candidate ${index}`]));
    const probabilities = Object.fromEntries(Object.keys(candidates).map((key) => [key, 1 / count]));
    const fetchImpl = vi.fn(async () => response({ layer: { type: "choice", choice: "c-0", max_probability: 1 / count, probabilities } }));
    const result = await new JuliaClient({ fetchImpl }).ask({}, { layer: choiceQuestion("Choose", candidates) });
    expect(Object.keys(result.answers.layer!.probabilities)).toHaveLength(count);
  });

  it("resolves a single legal candidate deterministically without calling the 2-option model", async () => {
    const fetchImpl = vi.fn();
    const result = await new JuliaClient({ fetchImpl }).ask({}, { layer: choiceQuestion("Choose", { only: "Only input" }) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.answers.layer).toEqual({ type: "choice", choice: "only", confidence: 1, probabilities: { only: 1 } });
    expect(result.provenance?.runtime).toBe("deterministic");
    expect(result.answerSources).toEqual({ layer: "deterministic" });
  });

  it("rejects excess, empty, unsupported and oversized questions before networking", async () => {
    const fetchImpl = vi.fn();
    const client = new JuliaClient({ fetchImpl });
    await expect(client.ask({}, { layer: { type: "choice", criteria: {} } })).rejects.toThrow();
    await expect(client.ask({}, { layer: choiceQuestion("Choose", Object.fromEntries(Array.from({ length: 21 }, (_, index) => [String(index), "Candidate"]))) })).rejects.toThrow("1–20");
    await expect(client.ask({}, { noul: { type: "noul" } })).rejects.toThrow("choice");
    await expect(client.ask("s".repeat(262_145), { layer: choiceQuestion("Choose", criteria) })).rejects.toThrow("256 KiB");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { model: JULIA_MODEL, answers: {} , provenance },
    { model: JULIA_MODEL, answers: { layer: nativeAnswer, extra: nativeAnswer }, provenance },
    { model: JULIA_MODEL, answers: { layer: nativeAnswer } },
    { model: JULIA_MODEL, answers: { layer: nativeAnswer }, provenance: { ...provenance, simulated: true } },
  ])("rejects missing/extra named answers or provenance (%#)", async (payload) => {
    const client = new JuliaClient({ fetchImpl: async () => new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }) });
    await expect(client.ask({}, { layer: choiceQuestion("Choose", criteria) })).rejects.toThrow();
  });

  it("keeps service errors visible without switching to demo or Jev", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "Strict encoding overflow" }), { status: 422, headers: { "content-type": "application/json" } }));
    await expect(new JuliaClient({ fetchImpl }).ask({}, { layer: choiceQuestion("Choose", criteria) })).rejects.toThrow("Strict encoding overflow");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("explicit provider selection", () => {
  it("requires concrete review for high-confidence Julia instead of silently auto-executing", async () => {
    const data = { type: "FeatureCollection", features: [{ type: "Feature", id: "school-1", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } }] };
    const state = { intent: "Buffer schools 250 meters", viewport: { bbox: [-1,-1,1,1] as [number,number,number,number], zoom: 12 }, layers: [summarizeFeatureCollection("schools", "Schools", data as never)], selection: { featureIds: [] }, previousActions: [] };
    const fetchImpl: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
        const keys = Object.keys((question as { criteria: object }).criteria);
        const choice = name === "action" ? "buffer" : "250m";
        return [name, { type: "choice", choice, max_probability: 0.99, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 0.99 : 0.01 / (keys.length - 1)])) }];
      }));
      return response(answers);
    };
    const context = { layers: new Map([["schools", data as never]]) };
    const plan = await prepareSpatialDecision(await createSpatialDecisionPlan(state, createDecisionClient("julia", { fetchImpl }), context), state, context);
    expect(plan.decisions.action.disposition).toBe("apply");
    expect(plan.policy).toBe("review");
    expect(plan.proposalPolicy).toBe("review");
    expect((await executeSpatialDecision({ ...plan, policy: "execute" }, state, context)).result).toBeUndefined();
    const pending = spatialDecisionReceipt(plan);
    expect((await executeSpatialDecision(plan, state, context, { approved: true, receipt: pending })).result?.tool).toBe("buffer");
  });

  it("keeps Jev-latest as default and Julia explicitly available", () => {
    expect(createDecisionClient("julia")).toBeInstanceOf(JuliaClient);
    expect(createDecisionClient("julia").model).toBe(JULIA_MODEL);
    expect(createDecisionClient().model).toBe("jev-latest");
    expect(createDecisionClient("jev", { jevModel: "jev-pinned" }).model).toBe("jev-pinned");
    expect(() => createDecisionClient("invalid" as never)).toThrow("Unknown decision provider");
  });

  it("uses Julia through the same plan, approval, validation and receipt path", async () => {
    const data = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-118.2, 34] } }] } as const;
    const spatialData = JSON.parse(JSON.stringify(data));
    const state = { intent: "Buffer schools 250 meters", viewport: { bbox: [-118.3, 33.9, -118.1, 34.1] as [number, number, number, number], zoom: 12 }, layers: [summarizeFeatureCollection("schools", "Schools", spatialData)], selection: { featureIds: [] }, previousActions: [] };
    const fetchImpl: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
        const keys = Object.keys((question as { criteria: object }).criteria);
        const choice = name === "action" ? "buffer" : "250m";
        return [name, { type: "choice", choice, max_probability: 0.7, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 0.7 : 0.3 / (keys.length - 1)])) }];
      }));
      return response(answers);
    };
    const plan = await createBufferDecisionPlan(state, createDecisionClient("julia", { fetchImpl }));
    expect(plan.decisionPayloads[0]?.model).toBe(JULIA_MODEL);
    expect(plan.policy).toBe("review");
    expect(createPendingDecisionReceipt(plan).execution.status).toBe("pending");
    const execution = await executeBufferDecision(plan, new Map([["schools", spatialData]]), undefined, true, state);
    expect(execution.receipt.execution.success).toBe(true);
    expect(execution.result?.data.features.length).toBe(1);
    expect(execution.receipt.stateDiff?.action).toBe("buffer");
    const invalid = { ...plan, call: { tool: "buffer" as const, args: { ...plan.call.args, distanceMeters: -1 } } };
    expect((await executeBufferDecision(invalid, new Map([["schools", spatialData]]), undefined, true, state)).receipt.validation.valid).toBe(false);
  });

  it("preserves modern workflow approvals, stale guards and receipt provenance", async () => {
    const data = { type: "FeatureCollection", features: [{ type: "Feature", id: "school-1", properties: { name: "School" }, geometry: { type: "Point", coordinates: [-118.2, 34] } }] };
    const state = { intent: "Buffer schools 250 meters", viewport: { bbox: [-118.3, 33.9, -118.1, 34.1] as [number, number, number, number], zoom: 12 }, layers: [summarizeFeatureCollection("schools", "Schools", data as never)], selection: { featureIds: [] }, previousActions: [] };
    const fetchImpl: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
        const keys = Object.keys((question as { criteria: object }).criteria);
        const choice = name === "action" ? "buffer" : "250m";
        return [name, { type: "choice", choice, max_probability: 0.7, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 0.7 : 0.3 / (keys.length - 1)])) }];
      }));
      return response(answers);
    };
    const context = { layers: new Map([["schools", data as never]]) };
    const plan = await prepareSpatialDecision(await createSpatialDecisionPlan(state, createDecisionClient("julia", { fetchImpl }), context), state, context);
    expect(plan.policy).toBe("review");
    expect(plan.decisionPayloads.every((payload) => payload.model === JULIA_MODEL)).toBe(true);
    const pending = spatialDecisionReceipt(plan);
    const denied = await executeSpatialDecision(plan, state, context, { receipt: pending });
    expect(denied.result).toBeUndefined();
    expect(denied.receipt.execution.status).toBe("pending");
    const approved = await executeSpatialDecision(plan, state, context, { approved: true, receipt: pending });
    expect(approved.receipt.execution.status).toBe("succeeded");
    expect(approved.receipt.provenance).toEqual(provenance);
    expect(approved.receipt.id).toBe(pending.id);
    const stale = await executeSpatialDecision(plan, { ...state, intent: "Export instead" }, context, { approved: true, receipt: pending });
    expect(stale.result).toBeUndefined();
    expect(stale.receipt.execution.status).toBe("not-run");
    expect(stale.receipt.id).toBe(pending.id);
    expect(stale.receipt.stateDiff).toEqual({});
    expect(stale.receipt.validation.warnings.join(" ")).toContain("stale");
    const invalid = { ...plan, calls: { buffer: { tool: "buffer" as const, args: { layerId: "schools", distanceMeters: -1 } } }, call: { tool: "buffer" as const, args: { layerId: "schools", distanceMeters: -1 } } };
    expect((await executeSpatialDecision(invalid, state, context, { approved: true })).result).toBeUndefined();
  });
});
