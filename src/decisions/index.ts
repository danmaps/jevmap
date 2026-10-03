import type { ChoiceQuestion, SystemOneRequest } from "../jev/index.js";

export const KEEP_CURRENT_OPTION_ID = "__keep__";
export type DecisionDisposition = "apply" | "review" | "clarify" | "keep" | "reject";

export interface ThresholdPolicy {
  kind: "threshold";
  applyAt: number;
  reviewAt: number;
}

export interface WinnerPolicy {
  kind: "winner";
  applyAt: number;
  reviewAt: number;
  /** The winner must lead the next option by this probability to apply. */
  minMargin: number;
}

export interface OrderedPolicy {
  kind: "ordered";
  applyAt: number;
  reviewAt: number;
  /** Probability near the weighted median is evidence for an ordinal choice. */
  maxRankDistance: number;
}

export interface ConfirmationPolicy {
  kind: "confirmation";
  reviewAt: number;
}

export type DecisionPolicy = ThresholdPolicy | WinnerPolicy | OrderedPolicy | ConfirmationPolicy;

export const THRESHOLD_POLICY: ThresholdPolicy = { kind: "threshold", applyAt: 0.8, reviewAt: 0.55 };
export const OPERATION_POLICY: WinnerPolicy = { kind: "winner", applyAt: 0.8, reviewAt: 0.55, minMargin: 0.15 };
export const LAYER_POLICY: WinnerPolicy = { kind: "winner", applyAt: 0.8, reviewAt: 0.55, minMargin: 0.2 };
export const DISTANCE_POLICY: OrderedPolicy = { kind: "ordered", applyAt: 0.8, reviewAt: 0.55, maxRankDistance: 1 };
export const EXPORT_POLICY: WinnerPolicy = { kind: "winner", applyAt: 0.8, reviewAt: 0.55, minMargin: 0.1 };
export const CONFIRMATION_POLICY: ConfirmationPolicy = { kind: "confirmation", reviewAt: 0.55 };

export interface DecisionOption<T> {
  id: string;
  value: T;
  label?: string;
  description: string;
}

export interface DecisionField<T> {
  label: string;
  question: string;
  currentValue: T;
  /** Optional bounded model representation for a large typed application value. */
  currentValueContext?: unknown;
  options: readonly DecisionOption<T>[];
  allowKeep?: boolean;
  policy: DecisionPolicy;
}

export interface DecisionSurface<TValues extends object> {
  /** Semantic context is independent of the application values being decided. */
  state: Record<string, unknown>;
  fields: { [K in keyof TValues]: DecisionField<TValues[K]> };
}

export interface DecisionFieldResult<T = unknown> {
  id: string;
  label: string;
  question: string;
  currentValue: T;
  selectedOptionId?: string;
  selectedValue?: T;
  confidence?: number;
  /** Policy evidence can differ from the model's reported confidence. */
  effectiveConfidence?: number;
  probabilities: Record<string, number>;
  optionLabels: Record<string, string>;
  policy: DecisionPolicy;
  disposition: DecisionDisposition;
  reason: string;
  changed: boolean;
  provenance: { model?: string; reportedOptionId?: string; source?: "model" | "deterministic" };
}

export interface DecisionSurfaceResult<TValues extends object> {
  fields: { [K in keyof TValues]: DecisionFieldResult<TValues[K]> };
  /** Only applied changes appear here. Review, keep and invalid answers never mutate state. */
  diff: Partial<TValues>;
}

export function buildDecisionPayload<TValues extends object>(
  surface: DecisionSurface<TValues>,
  model = "jev-latest",
): SystemOneRequest {
  validateSurface(surface);
  const entries = Object.entries(surface.fields) as [string, DecisionField<unknown>][];
  const questions = Object.fromEntries(entries.map(([id, field]): [string, ChoiceQuestion] => [id, {
    type: "choice",
    instructions: field.question,
    criteria: Object.fromEntries([
      ...field.options.map((option) => [option.id, option.description]),
      ...(field.allowKeep ? [[KEEP_CURRENT_OPTION_ID, "Keep the current value unchanged."]] : []),
    ]),
  }]));

  return {
    model,
    state: {
      ...surface.state,
      decisionFields: Object.fromEntries(entries.map(([id, field]) => [id, {
        label: field.label,
        currentValue: Object.hasOwn(field, "currentValueContext") ? field.currentValueContext : field.currentValue,
        allowKeep: field.allowKeep ?? false,
        policy: { ...field.policy },
      }])),
    },
    questions,
  };
}

export function parseDecisionSurface<TValues extends object>(
  surface: DecisionSurface<TValues>,
  response: unknown,
): DecisionSurfaceResult<TValues> {
  validateSurface(surface);
  const envelope = isRecord(response) ? response : {};
  const answers = isRecord(envelope.answers) ? envelope.answers : {};
  const model = typeof envelope.model === "string" ? envelope.model : undefined;
  const fields: Record<string, DecisionFieldResult> = {};
  const diff: Record<string, unknown> = {};

  for (const [id, field] of Object.entries(surface.fields) as [string, DecisionField<unknown>][]) {
    const result = parseField(id, field, answers[id], model);
    if (isRecord(envelope.answerSources) && ["model", "deterministic"].includes(String(envelope.answerSources[id]))) result.provenance.source = envelope.answerSources[id] as "model" | "deterministic";
    fields[id] = result;
    if (result.disposition === "apply" && result.changed) diff[id] = result.selectedValue;
  }
  return { fields, diff } as DecisionSurfaceResult<TValues>;
}

function parseField(id: string, field: DecisionField<unknown>, raw: unknown, model?: string): DecisionFieldResult {
  const optionLabels = Object.fromEntries(field.options.map((option) => [option.id, option.label ?? option.id]));
  if (field.allowKeep) optionLabels[KEEP_CURRENT_OPTION_ID] = "Keep current value";
  const base: DecisionFieldResult = {
    id, label: field.label, question: field.question, currentValue: field.currentValue,
    optionLabels, policy: { ...field.policy }, probabilities: {}, disposition: "reject",
    reason: "The field answer is missing or malformed.", changed: false,
    provenance: { ...(model ? { model } : {}) },
  };
  if (!isRecord(raw) || raw.type !== "choice") return base;
  if (typeof raw.choice === "string") base.provenance.reportedOptionId = raw.choice;
  if (typeof raw.confidence === "number" && Number.isFinite(raw.confidence)) base.confidence = raw.confidence;
  // Retain finite raw probabilities for inspection, even if a candidate or range is invalid.
  if (isRecord(raw.probabilities)) {
    base.probabilities = Object.fromEntries(Object.entries(raw.probabilities)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
  }
  if (typeof raw.choice !== "string" || !Object.hasOwn(optionLabels, raw.choice)) {
    return { ...base, reason: "The answer selected an unavailable option." };
  }
  if (!isProbability(raw.confidence)) return { ...base, reason: "The answer has invalid confidence." };
  if (!isRecord(raw.probabilities)) return { ...base, reason: "The answer has invalid probabilities." };
  const probabilities = raw.probabilities;
  const probabilityIds = Object.keys(probabilities);
  if (probabilityIds.some((candidate) => !Object.hasOwn(optionLabels, candidate) || !isProbability(probabilities[candidate]))) {
    return { ...base, reason: "The distribution includes an invalid or unavailable option." };
  }
  if (Object.keys(optionLabels).some((candidate) => !Object.hasOwn(probabilities, candidate))) {
    return { ...base, reason: "The distribution omits a legal option." };
  }
  const total = Object.values(base.probabilities).reduce((sum, probability) => sum + probability, 0);
  if (Math.abs(total - 1) > 0.01) return { ...base, reason: "The probabilities must sum to one." };
  const selected = field.options.find((option) => option.id === raw.choice);
  const keep = raw.choice === KEEP_CURRENT_OPTION_ID;
  const selectedValue = keep ? field.currentValue : selected!.value;
  const result: DecisionFieldResult = {
    ...base, selectedOptionId: raw.choice, selectedValue, confidence: raw.confidence,
    effectiveConfidence: raw.confidence, changed: !equalValues(selectedValue, field.currentValue),
  };
  // A legal no-op needs no application or confirmation. It cannot enter the typed diff.
  if (keep || !result.changed) return { ...result, disposition: "keep", reason: "Keep the current value unchanged." };
  return evaluatePolicy(result, field);
}

/**
 * Evaluate evidence for a side effect even when a field's value stays unchanged.
 * The caller retains its canonical keep record and empty diff; this result is an
 * independent execution gate. Invalid parsed answers remain rejected.
 */
export function evaluateDecisionFieldPolicy<T>(result: DecisionFieldResult<T>, field: DecisionField<T>): DecisionFieldResult<T> {
  if (result.disposition === "reject" || !isProbability(result.confidence) || result.selectedOptionId === undefined) return result;
  return evaluatePolicy(result, field, true) as DecisionFieldResult<T>;
}

function evaluatePolicy(result: DecisionFieldResult, field: DecisionField<unknown>, executionGate = false): DecisionFieldResult {
  const policy = field.policy;
  const confidence = result.confidence!;
  if (policy.kind === "confirmation") {
    return {
      ...result,
      disposition: confidence >= policy.reviewAt ? "review" : "clarify",
      reason: confidence >= policy.reviewAt ? "This field requires explicit user confirmation." : "Add context before requesting confirmation.",
    };
  }
  if (policy.kind === "threshold") return thresholdResult(result, confidence, policy, "reported confidence");
  if (policy.kind === "winner") {
    const ranked = Object.entries(result.probabilities).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const best = ranked[0]!;
    const runnerUp = ranked[1]?.[1] ?? 0;
    const margin = best[1] - runnerUp;
    if (best[0] !== result.selectedOptionId || (ranked.length > 1 && margin <= 1e-12)) {
      return { ...result, disposition: "clarify", reason: "The distribution does not identify one consistent winner." };
    }
    const evidence = Math.min(confidence, best[1]);
    const evaluated = thresholdResult(result, evidence, policy, "winner probability and reported confidence");
    if (evaluated.disposition === "apply" && margin + 1e-12 < policy.minMargin) {
      return { ...evaluated, disposition: "review", reason: "The leading option is insufficiently separated from the alternatives." };
    }
    return evaluated;
  }

  // Options are a declared ordinal scale. Never invent or interpolate a parameter value.
  const weights = field.options.map((option) => result.probabilities[option.id] ?? 0);
  const keepWeight = result.probabilities[KEEP_CURRENT_OPTION_ID] ?? 0;
  if (executionGate && result.selectedOptionId === KEEP_CURRENT_OPTION_ID) return thresholdResult(result, Math.min(confidence, keepWeight), policy, "keep probability and reported confidence");
  if (keepWeight >= Math.max(...weights)) {
    return { ...result, disposition: "clarify", reason: "The distribution does not distinguish changing the value from keeping it." };
  }
  const optionMass = weights.reduce((sum, weight) => sum + weight, 0);
  let cumulative = 0;
  const medianIndex = weights.findIndex((weight) => {
    cumulative += weight;
    return cumulative + 1e-12 >= optionMass / 2;
  });
  const median = field.options[medianIndex]!;
  const concentration = weights.reduce((sum, weight, index) => sum + (Math.abs(index - medianIndex) <= policy.maxRankDistance ? weight : 0), 0);
  const evaluated = thresholdResult({
    ...result, selectedOptionId: median.id, selectedValue: median.value,
    changed: !equalValues(median.value, field.currentValue),
  }, concentration, policy, "probability concentrated near the ordered median");
  if (!evaluated.changed && !executionGate) return { ...evaluated, disposition: "keep", reason: "The ordered distribution supports the current value." };
  return evaluated;
}

function thresholdResult(
  result: DecisionFieldResult,
  evidence: number,
  policy: ThresholdPolicy | WinnerPolicy | OrderedPolicy,
  source: string,
): DecisionFieldResult {
  const disposition = evidence >= policy.applyAt ? "apply" : evidence >= policy.reviewAt ? "review" : "clarify";
  return { ...result, effectiveConfidence: evidence, disposition, reason: `Policy ${disposition}: ${source} is ${Math.round(evidence * 100)}%.` };
}

function validateSurface<TValues extends object>(surface: DecisionSurface<TValues>): void {
  if (!isRecord(surface.state) || !isRecord(surface.fields)) throw new Error("A decision surface requires semantic state and fields.");
  const entries = Object.entries(surface.fields) as [string, DecisionField<unknown>][];
  if (entries.length === 0 || entries.length > 32) throw new Error("A decision surface requires 1 to 32 bounded fields.");
  for (const [id, field] of entries) {
    if (!id || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Decision field IDs must be safe nonempty keys.");
    if (!field || typeof field.label !== "string" || !field.label.trim() || typeof field.question !== "string" || !field.question.trim() || !Array.isArray(field.options) || field.options.length === 0 || field.options.length > 63) {
      throw new Error(`Decision field "${id}" requires a label, question and bounded legal options.`);
    }
    const ids = field.options.map((option) => option?.id);
    if (new Set(ids).size !== ids.length || ids.some((optionId) => typeof optionId !== "string" || !optionId.trim() || optionId === KEEP_CURRENT_OPTION_ID)) {
      throw new Error(`Decision field "${id}" has duplicate, empty or reserved option IDs.`);
    }
    if (field.options.some((option) => typeof option.description !== "string" || !option.description.trim())) throw new Error(`Decision field "${id}" requires option descriptions.`);
    const policy = field.policy;
    if (!policy || !["threshold", "winner", "ordered", "confirmation"].includes(policy.kind) || !isProbability(policy.reviewAt)) {
      throw new Error(`Decision field "${id}" has invalid policy.`);
    }
    if (policy.kind !== "confirmation" && (!isProbability(policy.applyAt) || policy.applyAt < policy.reviewAt)) throw new Error(`Decision field "${id}" has invalid policy thresholds.`);
    if (policy.kind === "winner" && !isProbability(policy.minMargin)) throw new Error(`Decision field "${id}" has invalid winner separation.`);
    if (policy.kind === "ordered" && (!Number.isInteger(policy.maxRankDistance) || policy.maxRankDistance < 0)) throw new Error(`Decision field "${id}" has invalid ordered distance.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function equalValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equalValues(value, b[index]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalValues(a[key], b[key]));
  }
  return false;
}
