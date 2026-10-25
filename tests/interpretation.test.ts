import { describe, expect, it } from "vitest";
import { renderDecisionInterpretation, renderInterpretationError } from "../src/interpretation/index.js";
import type { ActionReceipt } from "../src/receipts/index.js";
import { parseDecisionSurface, OPERATION_POLICY } from "../src/decisions/index.js";

function field(patch: Record<string, unknown> = {}) {
  return {
    id: "action", label: "Operation", currentValue: "buffer", selectedOptionId: "intersect",
    selectedValue: "intersect", confidence: .94, probabilities: { intersect: .84, select: .11, buffer: .05 },
    optionLabels: { intersect: "Intersect", select: "Select", buffer: "Buffer" },
    disposition: "apply", reason: "Choice meets operation policy.", changed: true,
    policy: { executeAt: .8, reviewAt: .55 }, ...patch,
  };
}

function receipt(patch: Record<string, unknown> = {}): ActionReceipt {
  return {
    id: "decision-123", timestamp: "2026-10-02T00:00:00Z", stateHash: "state", model: "jev-test",
    question: "Schools within the hazard area", probabilities: {}, confidence: .84,
    selectedAction: "intersect", args: {}, validation: { valid: true, warnings: [] },
    execution: { success: true, status: "succeeded", durationMs: 12 },
    decisions: { action: field() }, provenance: { backend: "jev", model: "jev-test", runtime: "remote", version: "0.1.0", simulated: false },
    ...patch,
  } as ActionReceipt;
}

describe("live decision interpretation", () => {
  it("distinguishes unused fallback parameters from applied choices", () => {
    const html = renderDecisionInterpretation(receipt({
      decisions: { action: field(), overlay: field({ id: "overlay", label: "Target layer" }) },
      guard: { originalChoice: "intersect", finalChoice: "select", fallback: true, ranking: [], rejected: [] },
      call: { tool: "select", args: { layerId: "schools", featureIds: ["school-1"] } },
    }));
    expect(html).toContain("Not used by fallback");
    expect(html).toContain("Replaced by fallback");
  });

  it("makes singleton application choices distinguishable from model inference", () => {
    expect(renderDecisionInterpretation(receipt({ decisions: { action: field({ provenance: { source: "deterministic" } }) } }))).toContain("no model inference");
  });

  it("renders the canonical parser result without adapting it into another UI record", () => {
    const parsed = parseDecisionSurface({ state: { intent: "Export schools" }, fields: { action: {
      label: "Operation", question: "Which operation advances the goal?", currentValue: null,
      options: [{ id: "select", value: "select", label: "Select", description: "Select a bounded feature set." }, { id: "export", value: "export", label: "Export GeoJSON", description: "Export the current layer." }],
      policy: OPERATION_POLICY,
    } } }, { model: "jev-test", answers: { action: { type: "choice", choice: "export", confidence: .99, probabilities: { select: .4, export: .6 } } } });
    const html = renderDecisionInterpretation(receipt({ decisions: parsed.fields, stateDiff: parsed.diff, execution: { success: false, status: "pending", durationMs: 0 } }));
    expect(html).toContain('<strong>Export GeoJSON</strong><span class="interpretation-probability">60% probability</span>');
    expect(html).toContain('Review required');
    expect(html).toContain('Returned confidence: 99%');
    expect(html).toContain('Policy evidence confidence: 60%');
  });

  it("shows every bounded selection, its own probability, and the policy disposition independently", () => {
    const html = renderDecisionInterpretation(receipt({ decisions: {
      action: field(),
      input: field({ id: "input", label: "Input layer", selectedOptionId: "schools", selectedValue: "schools", probabilities: { schools: .97, roads: .03 }, optionLabels: { schools: "Schools", roads: "Major roads" } }),
      hazard: field({ id: "hazard", label: "Hazard class", selectedOptionId: "very-high", selectedValue: "very-high", probabilities: { "very-high": .76, high: .24 }, optionLabels: { "very-high": "Very High", high: "High" }, disposition: "review", reason: "This class requires review." }),
    } }));
    expect(html).toContain('<h4>Operation</h4>');
    expect(html).toContain('<strong>Intersect</strong><span class="interpretation-probability">84% probability</span>');
    expect(html).toContain('data-field-id="input"');
    expect(html).toContain('<strong>Schools</strong><span class="interpretation-probability">97% probability</span>');
    expect(html).toContain('<strong>Very High</strong><span class="interpretation-probability">76% probability</span>');
    expect(html).toContain('data-disposition="review"');
    expect(html).toContain('Review required');
    expect(html).toContain('Applied by policy');
    expect(html).toContain('Returned confidence: 94%');
    expect(html).toContain('Jev · hosted · jev-test · remote · 0.1.0');
    expect(html).toContain('href="#receipt-decision-123"');
  });

  it("keeps full returned distributions behind collapsed details, including alternatives", () => {
    const html = renderDecisionInterpretation(receipt());
    expect(html).toContain('<details class="interpretation-distribution"><summary>All option probabilities</summary>');
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain('aria-label="Select probability"');
    expect(html).toContain('<b>11%</b>');
    expect(html).toContain('aria-label="Buffer probability"');
    expect(html).toContain('<b>5%</b>');
  });

  it("keeps verbose field policy reasons inside the collapsed distribution detail", () => {
    const reason = "The operation winner meets its field-specific confidence and runner-up margin thresholds.";
    const html = renderDecisionInterpretation(receipt({ decisions: { action: field({ reason }) } }));
    const fieldHtml = html.match(/<article class="interpretation-field"[\s\S]*?<\/article>/)?.[0] ?? "";
    expect(fieldHtml.split('<details class="interpretation-distribution">')[0]).not.toContain(reason);
    expect(fieldHtml.match(/<details class="interpretation-distribution">[\s\S]*?<\/details>/)?.[0]).toContain(reason);
    expect(fieldHtml).toContain('84% probability');
    expect(fieldHtml).toContain('Applied by policy');
  });

  it("shortens a long version to eight characters while retaining the full escaped version for inspection", () => {
    const version = "ab1234567890checkpoint";
    const html = renderDecisionInterpretation(receipt({ provenance: { backend: "julia", runtime: "python-cpu", model: "Julia-1", version, simulated: false } }));
    expect(html).toContain(`title="${version}"`);
    expect(html).toContain(`aria-label="Full model version: ${version}"`);
    expect(html).toContain('>ab123456…</span>');
    const escaped = renderDecisionInterpretation(receipt({ provenance: { version: '<bad version="unsafe">' } }));
    expect(escaped).not.toContain('title="<bad');
    expect(escaped).toContain('title="&lt;bad version=&quot;unsafe&quot;&gt;"');
  });

  it("preserves the reported model choice when an ordered policy selects a different candidate", () => {
    const html = renderDecisionInterpretation(receipt({ decisions: { distance: field({
      id: "distance", label: "Buffer distance", selectedOptionId: "500m", selectedValue: 500,
      probabilities: { "100m": .1, "250m": .38, "500m": .43, "1km": .09 },
      optionLabels: { "100m": "100 meters", "250m": "250 meters", "500m": "500 meters", "1km": "1 kilometer" },
      provenance: { reportedOptionId: "100m" }, effectiveConfidence: .81,
    }) } }));
    expect(html).toContain('<strong>100 meters</strong><span class="interpretation-probability">10% probability</span>');
    expect(html).toContain('Policy selected: <strong>500 meters</strong> · 43% probability');
    expect(html).toContain('Returned confidence: 94%');
    expect(html).toContain('Policy evidence confidence: 81%');
  });

  it("represents keep as an explicit unchanged choice without hiding its probability", () => {
    const html = renderDecisionInterpretation(receipt({ decisions: { distance: field({
      id: "distance", label: "Buffer distance", currentValue: 250, selectedOptionId: "keep", selectedValue: 250,
      probabilities: { keep: .68, "500m": .32 }, optionLabels: { keep: "Keep current distance", "500m": "500 meters" },
      disposition: "keep", changed: false,
    }) } }));
    expect(html).toContain('data-disposition="keep"');
    expect(html).toContain('Keep current distance');
    expect(html).toContain('68% probability');
    expect(html).toContain('Kept · unchanged');
    expect(html).toContain('Current value: 250');
  });

  it("keeps the model's explicit keep option distinct from the resolved guarded operation", () => {
    const html = renderDecisionInterpretation(receipt({
      decisions: { action: field({
        currentValue: "buffer", selectedOptionId: "__keep__", selectedValue: "buffer",
        probabilities: { __keep__: .9, buffer: .025, select: .025, filter: .025, export: .025 },
        optionLabels: { __keep__: "Keep current value", buffer: "Buffer", select: "Select", filter: "Filter", export: "Export" },
        provenance: { reportedOptionId: "__keep__" }, disposition: "keep", changed: false,
      }) },
      guard: { originalChoice: "buffer", finalChoice: "buffer", fallback: false, ranking: [], rejected: [] },
      selectedAction: "buffer",
    }));
    expect(html).toContain('<dt>Model selected</dt><dd>Keep current value <span>90% probability</span>');
    expect(html).toContain('<dt>Policy accepted operation</dt><dd>Buffer <span>2.5% probability</span>');
    expect(html).toContain('Current value: buffer');
    expect(html).not.toContain('<dt>Model selected</dt><dd>Buffer <span>2.5% probability</span>');
    expect(html).toContain('Buffer completed in 12 ms.');
  });

  it.each(["review", "clarify", "reject"])("shows a %s selection independently of a not-run execution", (disposition) => {
    const html = renderDecisionInterpretation(receipt({
      decisions: { action: field({ disposition, reason: "Application policy did not execute this selection." }) },
      execution: { success: false, status: disposition === "review" ? "pending" : "not-run", durationMs: 0 },
    }));
    expect(html).toContain(`data-disposition="${disposition}"`);
    expect(html).toContain('84% probability');
    expect(html).toContain('Application policy did not execute this selection.');
    expect(html).toContain(disposition === "review" ? 'Awaiting approval. No workbench operation has run.' : 'No workbench operation ran.');
    expect(html).not.toContain('completed');
  });

  it("distinguishes original selection, accepted fallback, and successful deterministic execution", () => {
    const html = renderDecisionInterpretation(receipt({
      selectedAction: "select",
      guard: { originalChoice: "intersect", finalChoice: "select", fallback: true, ranking: [{ id: "intersect", probability: .84 }, { id: "select", probability: .11 }], rejected: [{ id: "intersect", reason: "Incompatible geometry state" }] },
    }));
    expect(html).toContain('<dt>Model selected</dt><dd>Intersect <span>84% probability</span>');
    expect(html).toContain('<dt>Executed fallback</dt><dd>Select <span>11% probability</span>');
    expect(html).toContain('data-disposition="fallback"');
    expect(html).toContain('Replaced by fallback');
    expect(html).toContain('Original field policy: Applied by policy');
    expect(html).toContain('Incompatible geometry state');
    expect(html).toContain('<h4>Deterministic execution</h4><p>Select completed in 12 ms.</p>');
  });

  it("does not claim a fallback executed while awaiting approval", () => {
    const html = renderDecisionInterpretation(receipt({
      selectedAction: "select", guard: { originalChoice: "intersect", finalChoice: "select", fallback: true, rejected: [] },
      execution: { success: false, status: "pending", durationMs: 0 },
    }));
    expect(html).toContain('Policy accepted fallback');
    expect(html).toContain('11% probability');
    expect(html).toContain('Awaiting approval');
    expect(html).not.toContain('Executed fallback');
    expect(html).not.toContain('Select completed');
  });

  it("shows a guard rejection separately from the original accepted field policy", () => {
    const html = renderDecisionInterpretation(receipt({
      guard: { originalChoice: "intersect", fallback: false, ranking: [], rejected: [{ id: "intersect", reason: "Geometry is incompatible." }] },
      execution: { success: false, status: "not-run", durationMs: 0 },
    }));
    expect(html).toContain('data-disposition="reject"');
    expect(html).toContain('Rejected by execution guard');
    expect(html).toContain('Original field policy: Applied by policy');
    expect(html).toContain('84% probability');
    expect(html).toContain('No operation accepted');
    expect(html).toContain('No workbench operation ran.');
  });

  it("shows a successfully approved review field as applied without rewriting its original policy", () => {
    const html = renderDecisionInterpretation(receipt({
      decisions: { action: field({ disposition: "review" }) }, stateDiff: { action: "intersect" },
    }));
    expect(html).toContain('Applied after approval');
    expect(html).toContain('Original field policy: Review required');
    expect(html).toContain('data-disposition="apply"');
    expect(html).toContain('84% probability');
  });

  it("displays the exact proposed call and arguments before a review approval", () => {
    const html = renderDecisionInterpretation(receipt({
      call: { tool: "buffer", args: { layerId: "schools", distanceMeters: 250 } },
      execution: { success: false, status: "pending", durationMs: 0 },
    }));
    expect(html).toContain('PROPOSED WORKBENCH CALL');
    expect(html).toContain('buffer({&quot;layerId&quot;:&quot;schools&quot;,&quot;distanceMeters&quot;:250})');
    expect(html).not.toContain('EXECUTED WORKBENCH CALL');
    const executed = renderDecisionInterpretation(receipt({ call: { tool: "select", args: { layerId: "schools", featureIds: ["school-1"] } } }));
    expect(executed).toContain('EXECUTED WORKBENCH CALL');
    expect(executed).toContain('select({&quot;layerId&quot;:&quot;schools&quot;,&quot;featureIds&quot;:[&quot;school-1&quot;]})');
  });

  it("renders failed execution and malformed fields without inventing probabilities", () => {
    const html = renderDecisionInterpretation(receipt({
      decisions: { action: field({ selectedOptionId: undefined, selectedValue: undefined, confidence: NaN, probabilities: { intersect: NaN, select: 2, buffer: -.1 }, disposition: "reject" }), invalid: null },
      execution: { success: false, status: "failed", durationMs: 3, error: "Workbench validation failed" },
    }));
    expect(html).toContain('No valid choice');
    expect(html).toContain('Probability unavailable');
    expect(html).toContain('Returned confidence: unavailable');
    expect(html).toContain('Malformed decision field');
    expect(html).toContain('Workbench validation failed');
    expect(html).not.toContain('NaN%');
    expect(html).not.toContain('200%');
    expect(html).not.toContain('value="NaN"');
  });

  it("renders missing canonical decisions as an explicit unavailable state", () => {
    const html = renderDecisionInterpretation(receipt({ decisions: undefined }));
    expect(html).toContain('No valid decision fields were recorded.');
    expect(html).toContain('Inspect decision receipt');
  });

  it("escapes model labels, receipt text, and error text before HTML insertion", () => {
    const attack = '<img src=x onerror="alert(1)">';
    const html = renderDecisionInterpretation(receipt({
      decisions: { action: field({ label: attack, optionLabels: { intersect: attack }, reason: attack }) },
      provenance: { backend: attack, model: attack },
      execution: { status: "failed", error: attack },
      guard: { originalChoice: "intersect", rejected: [{ id: "intersect", reason: attack }] },
    }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(renderInterpretationError(attack)).not.toContain('<img');
  });

  it("shows request errors without creating a model selection or a synthetic receipt", () => {
    const html = renderInterpretationError("The proxy could not reach TypeSafe.");
    expect(html).toContain('role="alert"');
    expect(html).toContain('The proxy could not reach TypeSafe.');
    expect(html).toContain('No model decision was applied. No workbench operation ran.');
    expect(html).not.toContain('href="#receipt-');
    expect(html).not.toContain('Applied by policy');
    expect(html).not.toContain('probability');
  });

  it("identifies simulated decisions and real Julia provenance separately", () => {
    const demo = renderDecisionInterpretation(receipt({ provenance: { backend: "demo", runtime: "simulated", model: "demo-rules-v1", version: "1", simulated: true } }));
    expect(demo).toContain('Demo · simulated');
    expect(demo).toContain('Simulated decisions; no model inference.');
    const julia = renderDecisionInterpretation(receipt({ provenance: { backend: "julia", runtime: "python-cpu", model: "Julia-1", version: "checkpoint-1", simulated: false } }));
    expect(julia).toContain('Julia · local CPU · Julia-1 · python-cpu');
    expect(julia).toContain('title="checkpoint-1"');
    expect(julia).toContain('>checkpoi…</span>');
    expect(julia).not.toContain('Simulated decisions; no model inference.');
  });
});
