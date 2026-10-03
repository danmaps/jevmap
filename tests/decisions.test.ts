import { describe, expect, it } from "vitest";
import {
  buildDecisionPayload, parseDecisionSurface, evaluateDecisionFieldPolicy, KEEP_CURRENT_OPTION_ID,
  THRESHOLD_POLICY, OPERATION_POLICY, LAYER_POLICY, DISTANCE_POLICY,
  EXPORT_POLICY, CONFIRMATION_POLICY,
  type DecisionField, type DecisionPolicy, type DecisionSurface,
} from "../src/decisions/index.js";

function surface(policy: DecisionPolicy = THRESHOLD_POLICY, allowKeep = false): DecisionSurface<{ distance: number }> {
  return {
    state: { intent: "Buffer roads", layers: [{ id: "roads", featureCount: 2 }] },
    fields: {
      distance: {
        label: "Buffer distance", question: "Choose a legal distance", currentValue: 25,
        options: [
          { id: "25m", value: 25, label: "25 meters", description: "Use 25 meters" },
          { id: "100m", value: 100, label: "100 meters", description: "Use 100 meters" },
        ],
        allowKeep, policy,
      },
    },
  };
}

function response(confidence: number, choice = "100m", probabilities: Record<string, number> = { "25m": 1 - confidence, "100m": confidence }) {
  return { model: "jev-test", answers: { distance: { type: "choice", choice, confidence, probabilities } } };
}

describe("generic decision surfaces", () => {
  it("builds bounded questions and current-value context independently of the chosen values", () => {
    const payload = buildDecisionPayload(surface(THRESHOLD_POLICY, true), "jev-test");
    expect(payload.model).toBe("jev-test");
    expect(payload.state).toMatchObject({ intent: "Buffer roads", decisionFields: { distance: { currentValue: 25, allowKeep: true } } });
    expect(payload.questions.distance).toEqual({
      type: "choice", instructions: "Choose a legal distance",
      criteria: { "25m": "Use 25 meters", "100m": "Use 100 meters", [KEEP_CURRENT_OPTION_ID]: "Keep the current value unchanged." },
    });
  });

  it("returns the legal typed option value, labels, provenance and unchanged raw probabilities", () => {
    const result = parseDecisionSurface(surface(), response(0.9));
    const diff: Partial<{ distance: number }> = result.diff;
    expect(diff).toEqual({ distance: 100 });
    expect(result.fields.distance).toMatchObject({
      id: "distance", selectedValue: 100, selectedOptionId: "100m", changed: true,
      disposition: "apply", policy: THRESHOLD_POLICY,
      probabilities: { "25m": 1 - 0.9, "100m": 0.9 },
      optionLabels: { "25m": "25 meters", "100m": "100 meters" },
      provenance: { model: "jev-test", reportedOptionId: "100m" },
    });
  });

  it("keeps no-op and explicit keep answers out of the accepted diff", () => {
    const unchanged = parseDecisionSurface(surface(), response(1, "25m", { "25m": 1, "100m": 0 }));
    expect(unchanged.diff).toEqual({});
    expect(unchanged.fields.distance.disposition).toBe("keep");
    const kept = parseDecisionSurface(surface(THRESHOLD_POLICY, true), response(0.9, KEEP_CURRENT_OPTION_ID, { "25m": 0.05, "100m": 0.05, [KEEP_CURRENT_OPTION_ID]: 0.9 }));
    expect(kept.fields.distance.selectedValue).toBe(25);
    expect(kept.fields.distance.changed).toBe(false);
    expect(kept.fields.distance.disposition).toBe("keep");
    expect(kept.diff).toEqual({});
    expect(parseDecisionSurface(surface(), response(1, KEEP_CURRENT_OPTION_ID)).fields.distance.disposition).toBe("reject");
  });

  it("handles structured option values by value rather than reference", () => {
    const value = { enabled: true, layers: ["roads"] };
    const s: DecisionSurface<{ filter: typeof value }> = {
      state: {}, fields: { filter: { label: "Filter", question: "Choose a filter", currentValue: value,
        options: [{ id: "same", value: { layers: ["roads"], enabled: true }, description: "Keep the same filter" }], policy: THRESHOLD_POLICY } },
    };
    const result = parseDecisionSurface(s, { answers: { filter: { type: "choice", choice: "same", confidence: 1, probabilities: { same: 1 } } } });
    expect(result.fields.filter.disposition).toBe("keep");
    expect(result.diff).toEqual({});
  });

  it("allows compact current-value context without changing typed keep behavior", () => {
    const ids = Array.from({ length: 10_000 }, (_, index) => `feature-${index}`);
    const s: DecisionSurface<{ selection: string[] }> = { state: {}, fields: { selection: {
      label: "Selection", question: "Choose feature selection", currentValue: ids,
      currentValueContext: { count: ids.length, featureIds: ids.slice(0, 2) },
      options: [{ id: "all", value: ids, description: "Select all 10000 features" }],
      allowKeep: true, policy: LAYER_POLICY,
    } } };
    expect(JSON.stringify(buildDecisionPayload(s).state).length).toBeLessThan(500);
    const result = parseDecisionSurface(s, { answers: { selection: { type: "choice", choice: KEEP_CURRENT_OPTION_ID, confidence: 1, probabilities: { all: 0, [KEEP_CURRENT_OPTION_ID]: 1 } } } });
    expect(result.fields.selection.selectedValue).toEqual(ids);
    expect(result.fields.selection.disposition).toBe("keep");
    expect(result.diff).toEqual({});
  });

  it.each([
    {}, { answers: {} }, { answers: { distance: { type: "score" } } },
    response(1, "unavailable"), response(Number.NaN), response(1.1),
    response(0.9, "100m", { "25m": 0.1, "100m": 0.9, bad: 0 }),
    response(0.9, "100m", { "100m": 0.9 }),
    response(0.9, "100m", { "25m": -0.1, "100m": 1.1 }),
    response(0.9, "100m", { "25m": 0.1, "100m": Number.NaN }),
    response(0.9, "100m", { "25m": 0.1, "100m": 0.1 }),
  ])("rejects invalid answers without exposing an accepted state change: %j", (raw) => {
    const result = parseDecisionSurface(surface(), raw);
    expect(result.fields.distance.disposition).toBe("reject");
    expect(result.diff).toEqual({});
  });

  it("retains finite raw probability evidence when an unknown option causes rejection", () => {
    const result = parseDecisionSurface(surface(), response(0.9, "100m", { "25m": 0, "100m": 0.9, unknown: 0.1 }));
    expect(result.fields.distance.probabilities).toEqual({ "25m": 0, "100m": 0.9, unknown: 0.1 });
    expect(result.fields.distance.disposition).toBe("reject");
  });

  it("rejects unsafe or invalid surface definitions before sending a request", () => {
    const duplicate = surface();
    duplicate.fields.distance.options = [{ id: "same", value: 1, description: "One" }, { id: "same", value: 2, description: "Two" }];
    expect(() => buildDecisionPayload(duplicate)).toThrow(/duplicate/);
    duplicate.fields.distance.options = [{ id: 12, value: 1, description: "Invalid numeric identifier" }] as never;
    expect(() => buildDecisionPayload(duplicate)).toThrow(/empty or reserved/);
    expect(() => buildDecisionPayload(surface({ kind: "threshold", applyAt: 0.2, reviewAt: 0.8 }))).toThrow(/thresholds/);
    expect(() => buildDecisionPayload({ state: {}, fields: {} })).toThrow(/bounded fields/);
  });
});

describe("field-specific policies", () => {
  it("evaluates keep evidence as an independent side-effect gate without changing the canonical keep record", () => {
    for (const [confidence, disposition] of [[0.9, "apply"], [0.7, "review"], [0.4, "clarify"]] as const) {
      const s = surface(OPERATION_POLICY, true);
      const parsed = parseDecisionSurface(s, response(confidence, KEEP_CURRENT_OPTION_ID, {
        "25m": (1 - confidence) / 2, "100m": (1 - confidence) / 2, [KEEP_CURRENT_OPTION_ID]: confidence,
      }));
      const gate = evaluateDecisionFieldPolicy(parsed.fields.distance, s.fields.distance);
      expect(gate.disposition).toBe(disposition);
      expect(gate.changed).toBe(false);
      expect(parsed.fields.distance.disposition).toBe("keep");
      expect(parsed.diff).toEqual({});
    }
    const invalid = parseDecisionSurface(surface(), {});
    expect(evaluateDecisionFieldPolicy(invalid.fields.distance, surface().fields.distance).disposition).toBe("reject");
  });

  it.each([[0.8, "apply"], [0.8 - 1e-10, "review"], [0.55, "review"], [0.55 - 1e-10, "clarify"]] as const)("uses exact threshold boundaries at %s", (confidence, disposition) => {
    const result = parseDecisionSurface(surface(), response(confidence));
    expect(result.fields.distance.disposition).toBe(disposition);
    expect(result.diff).toEqual(disposition === "apply" ? { distance: 100 } : {});
  });

  it("uses winner evidence and deterministic tie handling for operations and eligible layers", () => {
    expect(parseDecisionSurface(surface(OPERATION_POLICY), response(0.99, "100m", { "25m": 0.45, "100m": 0.55 })).fields.distance.disposition).toBe("review");
    expect(parseDecisionSurface(surface(LAYER_POLICY), response(0.99, "100m", { "25m": 0.5, "100m": 0.5 })).fields.distance.disposition).toBe("clarify");
    expect(parseDecisionSurface(surface(LAYER_POLICY), response(0.99, "100m", { "25m": 0.9, "100m": 0.1 })).fields.distance.disposition).toBe("clarify");
    expect(parseDecisionSurface(surface(EXPORT_POLICY), response(0.9)).fields.distance.disposition).toBe("apply");
    const separation = { ...OPERATION_POLICY, minMargin: 0.9 };
    expect(parseDecisionSurface(surface(separation), response(0.9)).fields.distance.disposition).toBe("review");
  });

  it("requires explicit confirmation for destructive changes at every confidence", () => {
    for (const confidence of [0.55, 0.8, 1]) {
      const result = parseDecisionSurface(surface(CONFIRMATION_POLICY), response(confidence));
      expect(result.fields.distance.disposition).toBe("review");
      expect(result.diff).toEqual({});
    }
    expect(parseDecisionSurface(surface(CONFIRMATION_POLICY), response(0.54)).fields.distance.disposition).toBe("clarify");
  });

  function orderedSurface(): DecisionSurface<{ distance: number }> {
    const field: DecisionField<number> = {
      label: "Buffer distance", question: "Choose distance", currentValue: 0, policy: DISTANCE_POLICY,
      options: [25, 50, 100, 250, 500, 1000].map((value) => ({ id: `${value}m`, value, description: `${value} meters` })),
    };
    return { state: {}, fields: { distance: field } };
  }

  it("uses nearby ordinal probability mass without inventing numeric distances", () => {
    const result = parseDecisionSurface(orderedSurface(), response(0.38, "250m", { "25m": 0, "50m": 0, "100m": 0.1, "250m": 0.38, "500m": 0.43, "1000m": 0.09 }));
    expect(result.fields.distance).toMatchObject({ selectedOptionId: "500m", selectedValue: 500, confidence: 0.38, effectiveConfidence: 0.9, disposition: "apply", provenance: { reportedOptionId: "250m" } });
    expect(result.diff).toEqual({ distance: 500 });
    expect(result.fields.distance.probabilities["500m"]).toBe(0.43);
  });

  it("does not apply a distant bimodal distribution even when reported confidence is high", () => {
    const result = parseDecisionSurface(orderedSurface(), response(0.99, "25m", { "25m": 0.5, "50m": 0, "100m": 0, "250m": 0, "500m": 0, "1000m": 0.5 }));
    expect(result.fields.distance.disposition).toBe("clarify");
    expect(result.fields.distance.selectedValue).toBe(25);
    expect(result.diff).toEqual({});
    expect(parseDecisionSurface(orderedSurface(), response(0.99, "25m", { "25m": 0.5, "50m": 0, "100m": 0, "250m": 0, "500m": 0, "1000m": 0.5 }))).toEqual(result);
  });

  it("returns only applied changed fields from a mixed-policy surface", () => {
    const s: DecisionSurface<{ operation: string; enabled: boolean; distance: number }> = {
      state: {}, fields: {
        operation: { label: "Operation", question: "Choose", currentValue: "none", options: [{ id: "buffer", value: "buffer", description: "Buffer" }], policy: OPERATION_POLICY },
        enabled: { label: "Overwrite", question: "Overwrite?", currentValue: false, options: [{ id: "yes", value: true, description: "Overwrite" }], policy: CONFIRMATION_POLICY },
        distance: surface().fields.distance,
      },
    };
    const result = parseDecisionSurface(s, { answers: {
      operation: { type: "choice", choice: "buffer", confidence: 1, probabilities: { buffer: 1 } },
      enabled: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1 } },
      distance: { type: "choice", choice: "25m", confidence: 1, probabilities: { "25m": 1, "100m": 0 } },
    } });
    expect(result.diff).toEqual({ operation: "buffer" });
    expect([result.fields.operation.disposition, result.fields.enabled.disposition, result.fields.distance.disposition]).toEqual(["apply", "review", "keep"]);
  });
});
