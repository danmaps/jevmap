import { DEFAULT_DISTANCE_CANDIDATES, generateActionCandidates, type SpatialToolId } from "../candidates/index.js";
import { buildDecisionPayload, parseDecisionSurface, evaluateDecisionFieldPolicy, OPERATION_POLICY, LAYER_POLICY, DISTANCE_POLICY, EXPORT_POLICY, type DecisionField, type DecisionFieldResult } from "../decisions/index.js";
import type { DecisionClient, DecisionProvenance } from "../jev/providers.js";
import type { SystemOneRequest, SystemOneResponse } from "../jev/index.js";
import { createReceipt, type ActionReceipt, type DecisionGuardReceipt } from "../receipts/index.js";
import { semanticMapState, summarizeFeatureCollection, type JevMapState } from "../state/index.js";
import { ExecutionBoundaryError, executeWorkbenchCall, featureId, validateWorkbenchCall, workbenchDecisionValues, type WorkbenchCall, type WorkbenchContext, type WorkbenchResult } from "../workbench/index.js";
import { hashDecisionInputs, hashMapState } from "./index.js";
import { captureExecutionBoundary } from "./boundary.js";

export interface FallbackPolicy { minimumProbability: number; automaticAt: number }
export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = { minimumProbability: 0.1, automaticAt: 0.8 };
export interface SpatialDecisionPlan {
  model: string;
  provenance?: DecisionProvenance;
  inference: { durationMs: number; inputTokens?: number; outputTokens?: number };
  stateHash: string;
  executionStateHash: string;
  runtimeHash: string;
  question: string;
  semanticContext: Record<string, unknown>;
  decisions: Record<string, DecisionFieldResult>;
  stateDiff: Record<string, unknown>;
  decisionPayloads: SystemOneRequest[];
  modelResponses: SystemOneResponse[];
  calls: Partial<Record<SpatialToolId, WorkbenchCall>>;
  call?: WorkbenchCall;
  confidence: number;
  policy: "execute" | "review" | "clarify" | "reject";
  proposalPolicy: "execute" | "review" | "clarify" | "reject";
  approvalReason?: string;
  bindingHash: string;
  guard?: DecisionGuardReceipt;
  fallbackPolicy: FallbackPolicy;
}

export async function createSpatialDecisionPlan(
  state: JevMapState,
  client: DecisionClient,
  context: WorkbenchContext,
  currentValues: Record<string, unknown> = {},
  fallbackPolicy: FallbackPolicy = DEFAULT_FALLBACK_POLICY,
): Promise<SpatialDecisionPlan> {
  state = structuredClone(state);
  currentValues = structuredClone(currentValues);
  fallbackPolicy = { ...fallbackPolicy };
  context = { ...context, layers: structuredClone(new Map(context.layers)), ...(context.capabilities ? { capabilities: structuredClone(new Map(context.capabilities)) } : {}) };
  if (!state.layers.length) throw new Error("Load a GeoJSON layer before requesting a decision.");
  if (!Number.isFinite(fallbackPolicy.minimumProbability) || !Number.isFinite(fallbackPolicy.automaticAt) || fallbackPolicy.minimumProbability < 0 || fallbackPolicy.automaticAt > 1 || fallbackPolicy.minimumProbability > fallbackPolicy.automaticAt) throw new Error("Invalid fallback policy.");
  // Capture actual feature data before awaiting inference; summaries alone cannot detect edits beyond the sample.
  const stateHash = await hashMapState(state);
  const executionStateHash = await hashDecisionInputs(state);
  const runtimeHash = await hashRuntime(context);
  const authoritativeState = { ...state, layers: state.layers.filter((layer) => context.layers.has(layer.id)).map((layer) => ({ ...layer, ...summarizeFeatureCollection(layer.id, layer.name, context.layers.get(layer.id)!, 0), provenance: layer.provenance, capabilities: context.capabilities?.has(layer.id) ? context.capabilities.get(layer.id)!.filter((id) => !layer.capabilities || layer.capabilities.includes(id)) : layer.capabilities })) };
  const semanticContext = semanticMapState(authoritativeState);
  const decisions: Record<string, DecisionFieldResult> = {};
  const stateDiff: Record<string, unknown> = {};
  const decisionPayloads: SystemOneRequest[] = [];
  const modelResponses: SystemOneResponse[] = [];
  const fieldDefinitions: Record<string, DecisionField<unknown>> = {};
  const started = performance.now();
  async function decide(fields: Record<string, DecisionField<unknown>>): Promise<void> {
    Object.assign(fieldDefinitions, fields);
    const surface = { state: { ...semanticContext, proposedValues: Object.fromEntries(Object.entries(decisions).map(([id, result]) => [id, result.selectedValue])) }, fields };
    const payload = buildDecisionPayload(surface, client.model ?? "jev-latest");
    decisionPayloads.push(payload);
    const response = await client.ask(payload.state, payload.questions);
    modelResponses.push(response);
    const parsed = parseDecisionSurface(surface, response);
    Object.assign(decisions, parsed.fields);
    Object.assign(stateDiff, parsed.diff);
  }
  function field(id: string, label: string, question: string, options: DecisionField<unknown>["options"], policy = LAYER_POLICY): DecisionField<unknown> {
    const currentValue = currentValues[id] ?? null;
    return { label, question, currentValue, options, policy, allowKeep: currentValue !== null && options.some((option) => JSON.stringify(option.value) === JSON.stringify(currentValue)) };
  }
  const actionCandidates = generateActionCandidates(authoritativeState);
  if (!actionCandidates.length) throw new Error("No supported runtime layers are available.");
  const actionField = field("action", "Operation", "Choose the available spatial operation that best advances the user's goal.", actionCandidates.map((candidate) => ({ id: candidate.id, value: candidate.id, label: candidate.id, description: candidate.description })), OPERATION_POLICY);
  await decide({
    action: actionField,
  });
  const operation = decisions.action?.selectedValue as SpatialToolId | undefined;
  // The layer choice is bounded by current authoritative layer IDs, never by model-added metadata.
  const layerOptions = authoritativeState.layers.map((layer) => ({ id: layer.id, value: layer.id, label: layer.name, description: `${layer.name}: ${layer.featureCount} features, ${layer.geometryType} geometry.` }));
  const eligibleIds = actionCandidates.find((candidate) => candidate.id === operation)?.eligibleLayerIds ?? [];
  const fields: Record<string, DecisionField<unknown>> = { layer: field("layer", "Input layer", "Choose the input layer for this operation.", layerOptions.filter((option) => eligibleIds.includes(option.id))) };
  if (operation === "buffer") fields.distance = { ...field("distance", "Buffer distance", "Choose the appropriate legal distance.", DEFAULT_DISTANCE_CANDIDATES.map((candidate) => ({ id: candidate.id, value: candidate.meters, label: candidate.label, description: candidate.label }))), policy: DISTANCE_POLICY };
  if (operation === "export") fields.format = field("format", "Export format", "Choose the supported output format.", [{ id: "geojson", value: "geojson", label: "GeoJSON", description: "Export a GeoJSON FeatureCollection." }], EXPORT_POLICY);
  if (operation && fields.layer.options.length) await decide(fields);
  const layerId = decisions.layer?.selectedValue as string | undefined;
  const input = layerId ? context.layers.get(layerId) : undefined;
  if (operation === "intersect" || operation === "nearest") {
    const options = layerOptions.filter((option) => option.id !== layerId && (!authoritativeState.layers.find((layer) => layer.id === option.id)!.capabilities || authoritativeState.layers.find((layer) => layer.id === option.id)!.capabilities!.includes(operation)) && context.layers.get(option.id)?.features.length && context.layers.get(option.id)?.features.every((feature) => operation === "nearest" ? feature.geometry?.type === "Point" : ["Polygon", "MultiPolygon"].includes(feature.geometry?.type ?? "")));
    if (options.length) await decide({ overlay: field("overlay", operation === "nearest" ? "Target layer" : "Overlay layer", "Choose a distinct layer for the pairwise operation.", options) });
  }
  if (operation === "filter" && input) {
    const candidates: Array<{ id: string; value: { field: string; value: string | number | boolean | null }; label: string; description: string }> = [];
    const seen = new Set<string>();
    for (const feature of input.features) for (const [name, value] of Object.entries(feature.properties ?? {}).sort()) {
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) continue;
      const key = JSON.stringify([name, value]);
      if (seen.has(key) || candidates.length >= 19) continue;
      seen.add(key);
      const label = `${name} = ${JSON.stringify(value)}`;
      candidates.push({ id: `predicate-${candidates.length}`, value: { field: name, value: value as string | number | boolean | null }, label, description: label });
    }
    if (candidates.length) await decide({ predicate: field("predicate", "Attribute filter", "Choose one exact attribute filter from the supplied candidates.", candidates) });
  }
  if (operation === "select" && input) {
    const options = [
      { id: "all", value: input.features.map(featureId), label: "All features", description: "Select all input features." },
      ...input.features.slice(0, 18).map((feature, index) => ({ id: `id-${index}`, value: [featureId(feature, index)], label: String(feature.properties?.name ?? featureId(feature, index)), description: `Select ${feature.properties?.name ?? featureId(feature, index)}.` })),
    ];
    if (state.selection.layerId === layerId && state.selection.featureIds.length) options.push({ id: "current-selection", value: [...state.selection.featureIds], label: "Current selection", description: "Keep the current selected feature set." });
    const selectionField = field("selection", "Feature selection", "Choose a bounded feature set to select.", options);
    if (Array.isArray(selectionField.currentValue)) selectionField.currentValueContext = { count: selectionField.currentValue.length, featureIds: selectionField.currentValue.slice(0, 20) };
    await decide({ selection: selectionField });
  }
  const calls: SpatialDecisionPlan["calls"] = {};
  if (layerId) {
    // Fallback parameters are defined by application code, never invented by another model call.
    calls.export = { tool: "export", args: { layerId, format: "geojson" } };
    calls.select = { tool: "select", args: { layerId, featureIds: operation === "select" ? decisions.selection?.selectedValue as string[] ?? [] : input?.features.map(featureId) ?? [] } };
    if (decisions.distance?.selectedValue !== undefined) calls.buffer = { tool: "buffer", args: { layerId, distanceMeters: decisions.distance.selectedValue as number } };
    const otherId = decisions.overlay?.selectedValue as string | undefined;
    if (otherId) {
      calls.intersect = { tool: "intersect", args: { layerId, overlayLayerId: otherId } };
      calls.nearest = { tool: "nearest", args: { layerId, targetLayerId: otherId } };
    }
    const predicate = decisions.predicate?.selectedValue as { field: string; value: string | number | boolean | null } | undefined;
    if (predicate) calls.filter = { tool: "filter", args: { layerId, ...predicate } };
  }
  const dispositions = Object.values(decisions).map((result) => result.disposition);
  // Keeping a routing field is a no-op in the typed diff, but executing a GIS operation still has side effects.
  // Re-evaluate operation evidence independently so weak/tied keep answers cannot authorize those effects.
  for (const [id, result] of Object.entries(decisions)) if (result.disposition === "keep") {
    const executionGate = evaluateDecisionFieldPolicy(result, fieldDefinitions[id]!);
    dispositions.push(executionGate.disposition);
    decisions[id] = { ...result, reason: `${result.reason} Execution gate: ${executionGate.reason}` };
  }
  const latest = [...modelResponses].reverse().find((response) => response.provenance?.runtime !== "deterministic") ?? modelResponses.at(-1)!;
  const approvalReason = latest.provenance?.backend === "julia" ? "Experimental Julia decisions require review of the concrete call; high confidence can still misinterpret intent." : undefined;
  const policy = dispositions.includes("reject") ? "reject" : dispositions.includes("clarify") ? "clarify" : dispositions.includes("review") || approvalReason ? "review" : "execute";
  const usageAvailable = modelResponses.every((response) => response.usageReported !== false);
  const plan: SpatialDecisionPlan = {
    model: latest.model, provenance: latest.provenance, inference: { durationMs: Math.max(0, Math.round(performance.now() - started)), ...(usageAvailable ? { inputTokens: modelResponses.reduce((sum, response) => sum + response.usage.input_tokens, 0), outputTokens: modelResponses.reduce((sum, response) => sum + response.usage.output_tokens, 0) } : {}) },
    stateHash, executionStateHash, runtimeHash, question: state.intent, semanticContext, decisions, stateDiff, decisionPayloads, modelResponses, calls, ...(operation && calls[operation] ? { call: calls[operation] } : {}), confidence: Math.min(...Object.values(decisions).map((result) => result.confidence ?? 0)), policy, proposalPolicy: policy, approvalReason, bindingHash: "", fallbackPolicy: { ...fallbackPolicy },
  };
  plan.bindingHash = await hashPlanBinding(plan);
  return plan;
}

export async function prepareSpatialDecision(plan: SpatialDecisionPlan, state: JevMapState, context: WorkbenchContext): Promise<SpatialDecisionPlan> {
  const assertUnchanged = captureExecutionBoundary(plan, context, state);
  const originalChoice = String(plan.decisions.action?.selectedValue ?? plan.decisions.action?.provenance.reportedOptionId ?? "unavailable");
  const ranking = Object.entries(plan.decisions.action?.probabilities ?? {}).filter(([id]) => id !== "__keep__").map(([id, probability]) => ({ id, probability })).sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
  const guard: DecisionGuardReceipt = { originalChoice, ranking, rejected: [], fallback: false };
  const reject = (reason: string): SpatialDecisionPlan => ({ ...plan, call: undefined, stateDiff: {}, policy: "reject", guard: { ...guard, rejected: [...guard.rejected, { id: originalChoice, reason }] } });
  if (!plan.bindingHash || await hashPlanBinding(plan) !== plan.bindingHash) return reject("The bounded decision or call changed after inference. Request a fresh decision before execution.");
  if (await hashDecisionInputs(state) !== plan.executionStateHash || await hashRuntime(context) !== plan.runtimeHash) return reject("Map state is stale. Ask again before executing.");
  try { assertUnchanged(); } catch (error) { return reject((error as Error).message); }
  if (Object.values(plan.decisions).some((field) => field.disposition === "reject" || field.disposition === "clarify")) return reject("Bounded decision fields are invalid or unresolved. Add context and request a fresh decision.");
  if (plan.policy === "reject" || plan.policy === "clarify" || plan.proposalPolicy === "reject" || plan.proposalPolicy === "clarify") return { ...plan, call: undefined, policy: plan.proposalPolicy === "reject" || plan.proposalPolicy === "clarify" ? plan.proposalPolicy : plan.policy, guard };
  const basePolicy = plan.proposalPolicy === "review" || plan.policy === "review" ? "review" : "execute";
  const candidates = [originalChoice, ...ranking.filter((candidate) => candidate.id !== originalChoice && candidate.probability >= plan.fallbackPolicy.minimumProbability).map((candidate) => candidate.id)];
  for (const id of candidates) {
    const call = plan.calls[id as SpatialToolId];
    try {
      if (!Object.hasOwn(plan.decisions.action.optionLabels, id) || !call || call.tool !== id) throw new Error("No bounded parameter combination was supplied for this candidate.");
      validateWorkbenchCall(call, executionContext(state, context));
      guard.finalChoice = id;
      guard.fallback = id !== originalChoice;
      const probability = plan.decisions.action.probabilities[id] ?? 0;
      const policy = guard.fallback && probability < plan.fallbackPolicy.automaticAt ? "review" : basePolicy;
      const usedValues = workbenchDecisionValues(call);
      const stateDiff = Object.fromEntries(Object.entries(plan.decisions).filter(([key, field]) => Object.hasOwn(usedValues, key) && field.disposition === "apply" && field.changed).map(([key, field]) => [key, field.selectedValue]));
      if (guard.fallback) { delete stateDiff.action; if (policy === "execute") stateDiff.action = id; }
      return { ...plan, call, policy, stateDiff, guard };
    } catch (error) { guard.rejected.push({ id, reason: error instanceof Error ? error.message : "Candidate is infeasible." }); }
  }
  return reject("No candidate passed deterministic guards. Load compatible layers, reduce data size, or choose a supported operation.");
}

export function spatialDecisionReceipt(plan: SpatialDecisionPlan, existing?: ActionReceipt): ActionReceipt {
  return createReceipt({
    id: existing?.id, timestamp: existing?.timestamp,
    stateHash: plan.stateHash, model: plan.model, provenance: plan.provenance, inference: plan.inference,
    runtimeHash: plan.runtimeHash, executionStateHash: plan.executionStateHash,
    bindingHash: plan.bindingHash,
    question: plan.question, semanticContext: plan.semanticContext, decisions: plan.decisions, stateDiff: plan.stateDiff,
    decisionPayloads: plan.decisionPayloads, modelResponses: plan.modelResponses, guard: plan.guard, call: plan.call,
    probabilities: Object.fromEntries(Object.entries(plan.decisions).flatMap(([field, result]) => Object.entries(result.probabilities).map(([id, probability]) => [`${field}:${id}`, probability]))),
    confidence: plan.confidence, selectedAction: plan.guard?.finalChoice ?? String(plan.decisions.action?.selectedValue ?? "unavailable"), args: plan.call?.args,
    validation: { valid: false, warnings: [...(plan.guard?.rejected.map((item) => `${item.id}: ${item.reason}`) ?? []), ...(plan.approvalReason ? [plan.approvalReason] : [])] },
    execution: { success: false, durationMs: 0, status: plan.policy === "review" ? "pending" : "not-run", error: plan.policy === "review" ? plan.approvalReason ?? "Review the proposed call before execution." : plan.policy === "clarify" ? "Add context and ask again." : plan.policy === "reject" ? "No legal call can execute. Inspect guard reasons." : undefined },
  });
}

export async function executeSpatialDecision(plan: SpatialDecisionPlan, state: JevMapState, context: WorkbenchContext, options: { approved?: boolean; receipt?: ActionReceipt } = {}): Promise<{ result?: WorkbenchResult; receipt: ActionReceipt; plan: SpatialDecisionPlan }> {
  const assertUnchanged = captureExecutionBoundary(plan, context, state);
  const checked = await prepareSpatialDecision(plan, state, context);
  const approvalMatches = !options.approved || !options.receipt || (options.receipt.execution.status === "pending" && options.receipt.bindingHash === plan.bindingHash && options.receipt.executionStateHash === plan.executionStateHash && options.receipt.runtimeHash === plan.runtimeHash && JSON.stringify(options.receipt.call) === JSON.stringify(plan.call));
  if (!approvalMatches) {
    const rejected = { ...checked, policy: "reject" as const, call: undefined, stateDiff: {}, guard: { ...checked.guard!, finalChoice: undefined, rejected: [...(checked.guard?.rejected ?? []), { id: checked.guard?.originalChoice ?? "unavailable", reason: "Approval receipt does not match this concrete decision. Request and review a fresh decision." }] } };
    return { plan: rejected, receipt: spatialDecisionReceipt(rejected) };
  }
  const receipt = spatialDecisionReceipt(checked, options.receipt);
  // A newly proposed fallback requires its own concrete review; approval cannot cover a substitution that was never shown.
  const changedCall = JSON.stringify(checked.call) !== JSON.stringify(plan.call);
  if (!checked.call || checked.policy === "reject" || checked.policy === "clarify" || (checked.policy === "review" && (!options.approved || changedCall))) return { receipt, plan: checked };
  const started = performance.now();
  try {
    assertUnchanged();
    const result = await executeWorkbenchCall(checked.call, executionContext(state, context), { beforeExecute: assertUnchanged });
    const approvedDiff = { ...checked.stateDiff };
    const usedValues = workbenchDecisionValues(checked.call);
    if (options.approved) for (const [id, field] of Object.entries(checked.decisions)) if (Object.hasOwn(usedValues, id) && field.changed && field.disposition === "review") approvedDiff[id] = field.selectedValue;
    if (checked.guard?.fallback) for (const [id, value] of Object.entries(usedValues)) if (id === "action" || !Object.hasOwn(checked.decisions, id)) approvedDiff[id] = value;
    return { result, plan: checked, receipt: createReceipt({ ...receipt, stateDiff: approvedDiff, validation: { valid: true, warnings: receipt.validation.warnings }, execution: { success: true, status: "succeeded", durationMs: Math.max(0, Math.round(performance.now() - started)) } }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Spatial execution failed.";
    if (error instanceof ExecutionBoundaryError) {
      const rejected = { ...checked, policy: "reject" as const, call: undefined, stateDiff: {}, guard: { ...checked.guard!, finalChoice: undefined, rejected: [...(checked.guard?.rejected ?? []), { id: checked.guard?.finalChoice ?? "unavailable", reason: message }] } };
      return { plan: rejected, receipt: spatialDecisionReceipt(rejected, options.receipt) };
    }
    return { plan: checked, receipt: { ...receipt, validation: { valid: true, warnings: receipt.validation.warnings }, execution: { success: false, status: "failed", durationMs: Math.max(0, Math.round(performance.now() - started)), error: message } } };
  }
}

async function hashRuntime(context: WorkbenchContext): Promise<string> {
  // Reuse the stable state hasher with a separate runtime snapshot; coordinates remain local.
  return hashMapState({ layers: [...context.layers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, data]) => ({ id, data })), capabilities: context.capabilities ? [...context.capabilities].sort(([a], [b]) => a.localeCompare(b)) : undefined, limits: [context.maxFeatures, context.maxPairComparisons, context.maxExportBytes] } as unknown as JevMapState);
}

function executionContext(state: JevMapState, context: WorkbenchContext): WorkbenchContext {
  const capabilities = new Map(context.capabilities);
  for (const layer of state.layers) if (layer.capabilities) {
    capabilities.set(layer.id, layer.capabilities.filter((id) => !capabilities.has(layer.id) || capabilities.get(layer.id)!.includes(id as SpatialToolId)) as SpatialToolId[]);
  }
  return { ...context, capabilities };
}

async function hashPlanBinding(plan: SpatialDecisionPlan): Promise<string> {
  return hashMapState({ decisions: plan.decisions, calls: plan.calls, proposalPolicy: plan.proposalPolicy, approvalReason: plan.approvalReason, fallbackPolicy: plan.fallbackPolicy, stateHash: plan.stateHash, executionStateHash: plan.executionStateHash, runtimeHash: plan.runtimeHash } as unknown as JevMapState);
}
