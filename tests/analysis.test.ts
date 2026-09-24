import { describe, expect, it, vi } from "vitest";
import {
  createBufferDecisionPlan,
  createPendingDecisionReceipt,
  executeBufferDecision,
  hashDecisionInputs,
  hashMapState,
  type DecisionClient,
  type SpatialData,
} from "../src/analysis/index.js";
import { generateBufferCandidates } from "../src/candidates/index.js";
import { parseChoiceAnswer, parseSystemOneResponse } from "../src/jev/index.js";
import { JevProxyClient } from "../src/jev/proxy-client.js";
import { parseFeatureCollection } from "../src/state/geojson.js";
import { summarizeFeatureCollection, type JevMapState } from "../src/state/index.js";
import { executeWorkbenchCall } from "../src/workbench/index.js";

const roads: SpatialData = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Main Street", class: "major road" },
      geometry: { type: "LineString", coordinates: [[-0.12, 51.5], [-0.11, 51.51]] },
    },
  ],
};

function makeState(data: SpatialData = roads): JevMapState {
  const layer = summarizeFeatureCollection("roads", "major-roads", data);
  return {
    intent: "Create a 250 meter buffer around the major roads.",
    viewport: { bbox: [-0.2, 51.4, -0.05, 51.6], zoom: 12 },
    layers: [layer],
    selection: { featureIds: [] },
    previousActions: [],
  };
}

function fakeClient(confidence = 0.9): DecisionClient {
  return {
    async ask(state, questions) {
      expect(state).toHaveProperty("intent");
      const choices: Record<string, string> = { action: "buffer", layer: "roads", distance: "250m" };
      const answers = Object.fromEntries(
        Object.entries(questions).map(([name, question]) => {
          const criteria = question.type === "choice" ? question.criteria : {};
          const choice = choices[name] ?? Object.keys(criteria)[0] ?? "";
          const otherKeys = Object.keys(criteria).filter((key) => key !== choice);
          const probabilities = Object.fromEntries(
            Object.keys(criteria).map((key) => [key, key === choice ? (otherKeys.length ? confidence : 1) : (1 - confidence) / otherKeys.length]),
          );
          return [name, { type: "choice", choice, confidence, probabilities }];
        }),
      );
      return {
        model: "test-jev",
        answers: answers as never,
        usage: { input_tokens: 10, output_tokens: 4 },
      };
    },
  };
}

describe("GeoJSON state and bounded candidates", () => {
  it("summarizes extents, fields, geometry, and a bounded sample", () => {
    const layer = summarizeFeatureCollection("roads", "Roads", roads, 0);
    expect(layer.geometryType).toBe("LineString");
    expect(layer.fields).toEqual([
      { name: "name", type: "string" },
      { name: "class", type: "string" },
    ]);
    expect(layer.extent).toEqual([-0.12, 51.5, -0.11, 51.51]);
    expect(layer.sample?.features).toHaveLength(0);
  });

  it("only offers buffering when a layer has spatial features", () => {
    const state = makeState();
    expect(generateBufferCandidates(state).map((candidate) => candidate.id)).toEqual(["buffer"]);

    const emptyState = makeState({ type: "FeatureCollection", features: [] });
    expect(generateBufferCandidates(emptyState)).toEqual([]);
  });

  it("parses GeoJSON FeatureCollections and rejects malformed uploads", () => {
    expect(parseFeatureCollection(JSON.stringify(roads)).features).toHaveLength(1);
    expect(() => parseFeatureCollection("{")).toThrow(/valid JSON/);
    expect(() =>
      parseFeatureCollection(JSON.stringify({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [] } }],
      })),
    ).toThrow(/valid coordinates/);
  });

  it("hashes equivalent map states deterministically", async () => {
    const state = makeState();
    expect(await hashMapState(state)).toBe(await hashMapState({ ...state, viewport: { ...state.viewport } }));
  });

  it("keeps viewport changes out of approval freshness checks", async () => {
    const state = makeState();
    const panned = { ...state, viewport: { bbox: [-1, 50, 1, 52] as [number, number, number, number], zoom: 7 } };
    expect(await hashDecisionInputs(state)).toBe(await hashDecisionInputs(panned));
  });
});

describe("TypeSafe response validation", () => {
  it("rejects an answer outside the supplied candidates", () => {
    expect(() =>
      parseChoiceAnswer(
        { type: "choice", choice: "delete-everything", confidence: 1, probabilities: { buffer: 1 } },
        "action",
        { buffer: "Buffer" },
      ),
    ).toThrow(/unavailable choice/);
  });

  it("normalizes the System One response envelope and rejects malformed responses", () => {
    expect(parseSystemOneResponse({ model: "jev", answers: {} }).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(() => parseSystemOneResponse({ answers: {} })).toThrow(/malformed/);
  });

  it("calls the browser fetch function with its global receiver by default", async () => {
    const receivers: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(new Response(JSON.stringify({ model: "jev", answers: {}, usage: {} }), {
        headers: { "content-type": "application/json" },
      }));
    }));

    try {
      await new JevProxyClient().ask({ intent: "buffer roads" }, {});
      expect(receivers).toEqual([globalThis]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends decisions through the server-side Jev proxy", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ model: "jev", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = new JevProxyClient({ fetchImpl });
    await client.ask({ intent: "buffer roads" }, { action: { type: "choice", criteria: { buffer: "Buffer" } } });
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { model: string; state: { intent: string } };
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("/api/jev");
    expect(request.method).toBe("POST");
    expect(body.model).toBe("jev-latest");
    expect(body.state.intent).toBe("buffer roads");
  });

  it("explains when the Caddy Jev proxy route is missing", async () => {
    const client = new JevProxyClient({
      fetchImpl: vi.fn(async () => new Response("<html>not found</html>", { headers: { "content-type": "text/html" } })),
    });
    await expect(client.ask({ intent: "buffer roads" }, {})).rejects.toThrow(/Add the \/api\/jev Caddy route/);
  });
});

describe("first buffer workflow", () => {
  it("records request time and usage independently of GIS execution", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(350);
    try {
      const plan = await createBufferDecisionPlan(makeState(), fakeClient());
      expect(plan.inference).toEqual({ durationMs: 250, inputTokens: 10, outputTokens: 4 });
      const pending = createPendingDecisionReceipt(plan);
      expect(pending.inference).toEqual(plan.inference);
      expect(pending.execution.durationMs).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
  it("executes a high-confidence buffer and records a successful receipt", async () => {
    const state = makeState();
    const plan = await createBufferDecisionPlan(state, fakeClient());
    expect(plan.policy).toBe("execute");
    expect(plan.call).toEqual({ tool: "buffer", args: { layerId: "roads", distanceMeters: 250 } });

    const result = await executeBufferDecision(plan, new Map([["roads", roads]]));
    expect(result.result?.data.features[0]?.geometry?.type).toBe("Polygon");
    expect(result.receipt.validation.valid).toBe(true);
    expect(result.receipt.execution).toMatchObject({ success: true, status: "succeeded" });
    expect(result.receipt.stateHash).toBe(plan.stateHash);
    expect(Object.keys(result.receipt.probabilities)).toContain("distance:250m");
  });

  it("holds medium-confidence decisions for review", async () => {
    const plan = await createBufferDecisionPlan(makeState(), fakeClient(0.7));
    expect(plan.policy).toBe("review");
    const receipt = createPendingDecisionReceipt(plan);
    expect(receipt.execution.status).toBe("pending");
    expect(receipt.validation.valid).toBe(false);
  });

  it("rejects unknown layers before the deterministic operation", async () => {
    const plan = await createBufferDecisionPlan(makeState(), fakeClient());
    const result = await executeBufferDecision(plan, new Map());
    expect(result.result).toBeUndefined();
    expect(result.receipt.validation.valid).toBe(false);
    expect(result.receipt.execution.status).toBe("failed");
    expect(result.receipt.execution.error).toMatch(/Unknown layer/);
  });

  it("performs a Turf buffer through the validated workbench", async () => {
    const result = await executeWorkbenchCall(
      { tool: "buffer", args: { layerId: "roads", distanceMeters: 100 } },
      { layers: new Map([["roads", roads]]) },
    );
    expect(result.layerId).toBe("roads__buffer_100m");
    expect(result.data.features).toHaveLength(1);
  });
});
