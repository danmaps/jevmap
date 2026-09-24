import { describe, expect, it } from "vitest";
import { estimateInferenceCost, formatCost, INFERENCE_RATES } from "../src/inference-cost.js";
import { parseSystemOneResponse } from "../src/jev/index.js";

describe("inference cost estimates", () => {
  it("uses per-million rates and does not charge Jev output tokens", () => {
    expect(estimateInferenceCost(2000, 300, INFERENCE_RATES[0])).toBeCloseTo(0.000084, 9);
    expect(estimateInferenceCost(2000, 300, INFERENCE_RATES[1])).toBeCloseTo(0.00035, 9);
    expect(estimateInferenceCost(2000, 300, INFERENCE_RATES[2])).toBeCloseTo(0.007, 9);
  });
  it("keeps missing or invalid usage distinct from a free call", () => {
    for (const usage of [undefined, {}, { input_tokens: -1, output_tokens: 0 }, { input_tokens: NaN, output_tokens: 0 }]) {
      expect(parseSystemOneResponse({ model: "jev", answers: {}, usage }).usageReported).toBe(false);
    }
    expect(parseSystemOneResponse({ model: "jev", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }).usageReported).toBe(true);
    expect(estimateInferenceCost(-1, 300, INFERENCE_RATES[0])).toBeUndefined();
    expect(formatCost(undefined)).toBe("Unavailable");
    expect(formatCost(0.000000042)).toBe("<$0.000001");
  });
});
