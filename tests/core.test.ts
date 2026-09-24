import { describe, expect, it } from "vitest";
import { generateActionCandidates } from "../src/candidates/index.js";
import { applyDecisionPolicy } from "../src/jev/index.js";
import type { JevMapState } from "../src/state/index.js";

function makeState(layerCount: number): JevMapState {
  return {
    intent: "Find parks near schools",
    viewport: {
      bbox: [-118, 33, -117, 34],
      zoom: 10,
    },
    layers: Array.from({ length: layerCount }, (_, index) => ({
      id: `layer-${index + 1}`,
      name: `Layer ${index + 1}`,
      geometryType: "Point",
      featureCount: 10,
      fields: [],
      summary: {
        featureCount: 10,
        geometryTypes: ["Point"],
      },
    })),
    selection: {
      featureIds: [],
    },
    previousActions: [],
  };
}

describe("applyDecisionPolicy", () => {
  it("executes high-confidence decisions", () => {
    expect(applyDecisionPolicy(0.9)).toBe("execute");
  });

  it("routes medium confidence to review", () => {
    expect(applyDecisionPolicy(0.7)).toBe("review");
  });

  it("routes low confidence to clarification", () => {
    expect(applyDecisionPolicy(0.4)).toBe("clarify");
  });
});

describe("generateActionCandidates", () => {
  it("exposes pairwise spatial tools when two or more layers exist", () => {
    const ids = generateActionCandidates(makeState(2)).map((candidate) => candidate.id);
    expect(ids).toContain("intersect");
    expect(ids).toContain("nearest");
  });

  it("omits pairwise tools for a single layer", () => {
    const ids = generateActionCandidates(makeState(1)).map((candidate) => candidate.id);
    expect(ids).not.toContain("intersect");
    expect(ids).not.toContain("nearest");
  });
});
