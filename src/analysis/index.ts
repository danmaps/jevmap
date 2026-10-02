import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";
import {
  actionCriteria,
  DEFAULT_DISTANCE_CANDIDATES,
  distanceCriteria,
  generateActionCandidates,
  layerCriteria,
  type DistanceCandidate,
} from "../candidates/index.js";
import {
  applyDecisionPolicy,
  choiceQuestion,
  parseChoiceAnswer,
  type ChoiceAnswer,
  type DecisionPolicy,
  type DecisionPolicyResult,
  type SystemOneRequest,
  type SystemOneResponse,
} from "../jev/index.js";
import { buildDecisionPayload, parseDecisionSurface, OPERATION_POLICY, LAYER_POLICY, DISTANCE_POLICY, type DecisionFieldResult } from "../decisions/index.js";
import type { DecisionProvenance } from "../jev/providers.js";
import { createReceipt, type ActionReceipt } from "../receipts/index.js";
import { semanticMapState, type JevMapState } from "../state/index.js";
import {
  executeWorkbenchCall,
  validateWorkbenchCall,
  type BufferCall,
  type WorkbenchResult,
} from "../workbench/index.js";

export interface DecisionClient {
  ask(
    state: SystemOneRequest["state"],
    questions: SystemOneRequest["questions"],
  ): Promise<SystemOneResponse>;
}

export interface BufferDecisionPlan {
  model: string;
  provenance?: DecisionProvenance;
  inference: {
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  stateHash: string;
  executionStateHash: string;
  question: string;
  action: ChoiceAnswer;
  layer: ChoiceAnswer;
  distance: ChoiceAnswer;
  distanceCandidate: DistanceCandidate;
  confidence: number;
  policy: DecisionPolicyResult;
  probabilities: Record<string, Record<string, number>>;
  call: BufferCall;
  decisions: Record<string, DecisionFieldResult>;
  stateDiff: Record<string, unknown>;
  semanticContext: Record<string, unknown>;
  runtimeHash?: string;
  decisionPayloads: SystemOneRequest[];
  modelResponses: SystemOneResponse[];
  bindingHash: string;
}

export async function createBufferDecisionPlan(
  state: JevMapState,
  client: DecisionClient,
  policy?: DecisionPolicy,
  runtimeLayers?: ReadonlyMap<string, SpatialData>,
): Promise<BufferDecisionPlan> {
  const actionCandidates = generateActionCandidates(state);
  if (actionCandidates.length === 0) {
    throw new Error("Load at least one GeoJSON layer with spatial features before asking Jev to choose an operation.");
  }
  const bufferCandidate = actionCandidates.find((candidate) => candidate.id === "buffer");
  const questions = {
    action: choiceQuestion(
      "Choose the available Workbench operation that best advances the user's goal.",
      actionCriteria(actionCandidates),
    ),
    layer: choiceQuestion(
      "Choose one eligible input layer for the selected Workbench operation.",
      layerCriteria(state, bufferCandidate?.eligibleLayerIds ?? state.layers.map((layer) => layer.id)),
    ),
    distance: choiceQuestion(
      "Choose the most appropriate buffer distance from the legal candidates for the user's goal.",
      distanceCriteria(DEFAULT_DISTANCE_CANDIDATES),
    ),
  };

  const semanticContext = semanticMapState(state);
  const surface = {
    state: semanticContext,
    fields: {
      action: { label: "Operation", question: String(questions.action.instructions), currentValue: null as string | null, options: Object.entries(questions.action.criteria).map(([id, description]) => ({ id, value: id, description: String(description) })), policy: OPERATION_POLICY },
      layer: { label: "Input layer", question: String(questions.layer.instructions), currentValue: null as string | null, options: Object.entries(questions.layer.criteria).map(([id, description]) => ({ id, value: id, description: String(description) })), policy: LAYER_POLICY },
      distance: { label: "Buffer distance", question: String(questions.distance.instructions), currentValue: null as number | null, options: DEFAULT_DISTANCE_CANDIDATES.map((candidate) => ({ id: candidate.id, value: candidate.meters, label: candidate.label, description: candidate.label })), policy: DISTANCE_POLICY },
    },
  };
  const payload = buildDecisionPayload(surface);
  const completeLayers = runtimeLayers ?? new Map(state.layers.filter((item) => item.sample?.features.length === item.featureCount).map((item) => [item.id, item.sample!]));
  const runtimeHash = completeLayers.size === state.layers.length ? await hashRuntimeLayers(completeLayers) : undefined;
  const inferenceStarted = performance.now();
  const response = await client.ask(payload.state, payload.questions);
  const inferenceDurationMs = Math.max(0, Math.round(performance.now() - inferenceStarted));
  const action = parseChoiceAnswer(response.answers.action, "action", questions.action.criteria);
  const layer = parseChoiceAnswer(response.answers.layer, "layer", questions.layer.criteria);
  const distance = parseChoiceAnswer(response.answers.distance, "distance", questions.distance.criteria);
  const parsed = parseDecisionSurface(surface, response);
  if (Object.values(parsed.fields).some((field) => field.disposition === "reject")) throw new Error("The bounded buffer response is malformed.");
  if (action.choice !== "buffer") throw new Error("Use the spatial decision workflow for operations other than Buffer.");
  const distanceCandidate = DEFAULT_DISTANCE_CANDIDATES.find((candidate) => candidate.meters === parsed.fields.distance.selectedValue);
  if (!distanceCandidate) throw new Error("The selected buffer distance is not available.");
  const confidence = Math.min(action.confidence, layer.confidence, distance.confidence);
  const fieldPolicy: DecisionPolicyResult = Object.values(parsed.fields).some((field) => field.disposition === "clarify") ? "clarify" : Object.values(parsed.fields).some((field) => field.disposition === "review") ? "review" : "execute";
  const requestedPolicy = policy ? applyDecisionPolicy(confidence, policy) : fieldPolicy;
  const combinedPolicy = fieldPolicy === "clarify" || requestedPolicy === "clarify" ? "clarify" : fieldPolicy === "review" || requestedPolicy === "review" ? "review" : "execute";
  const plan: BufferDecisionPlan = {
    model: response.model,
    provenance: response.provenance,
    inference: {
      durationMs: inferenceDurationMs,
      ...(response.usageReported === false ? {} : {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }),
    },
    stateHash: await hashMapState(state),
    executionStateHash: await hashDecisionInputs(state),
    question: state.intent,
    action,
    layer,
    distance,
    distanceCandidate,
    confidence,
    policy: combinedPolicy,
    bindingHash: "",
    decisions: parsed.fields,
    stateDiff: parsed.diff,
    semanticContext,
    runtimeHash,
    decisionPayloads: [payload],
    modelResponses: [response],
    probabilities: {
      action: action.probabilities,
      layer: layer.probabilities,
      distance: distance.probabilities,
    },
    call: {
      tool: "buffer",
      args: {
        layerId: layer.choice,
        distanceMeters: distanceCandidate.meters,
      },
    },
  };
  plan.bindingHash = await hashBufferBinding(plan);
  return plan;
}

export async function hashMapState(state: JevMapState): Promise<string> {
  return hashSerialized(stableStringify(state));
}

export async function hashDecisionInputs(state: JevMapState): Promise<string> {
  return hashSerialized(
    stableStringify({
      intent: state.intent,
      layers: state.layers,
      selection: state.selection,
      previousActions: state.previousActions,
    }),
  );
}

async function hashSerialized(serialized: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function flattenProbabilities(groups: Record<string, Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(groups).flatMap(([group, values]) =>
      Object.entries(values).map(([candidate, probability]) => [`${group}:${candidate}`, probability]),
    ),
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function createPendingDecisionReceipt(plan: BufferDecisionPlan): ActionReceipt {
  const isReview = plan.policy === "review";
  const message = isReview
    ? "Awaiting user approval before workbench execution."
    : "Confidence is below the execution threshold; add context and ask again.";

  return createReceipt({
    stateHash: plan.stateHash,
    executionStateHash: plan.executionStateHash,
    runtimeHash: plan.runtimeHash,
    bindingHash: plan.bindingHash,
    model: plan.model,
    provenance: plan.provenance,
    decisionPayloads: plan.decisionPayloads,
    modelResponses: plan.modelResponses,
    decisions: plan.decisions,
    stateDiff: plan.stateDiff,
    semanticContext: plan.semanticContext,
    call: plan.call,
    inference: plan.inference,
    question: plan.question,
    probabilities: flattenProbabilities(plan.probabilities),
    confidence: plan.confidence,
    selectedAction: plan.action.choice,
    args: plan.call.args,
    validation: {
      valid: false,
      warnings: [isReview ? "Execution requires user review." : "No workbench call was executed."],
    },
    execution: {
      success: false,
      durationMs: 0,
      status: isReview ? "pending" : "not-run",
      error: message,
    },
  });
}

export async function executeBufferDecision(
  plan: BufferDecisionPlan,
  layers: ReadonlyMap<string, FeatureCollection<Geometry, GeoJsonProperties>>,
  existingReceipt?: ActionReceipt,
  approved = false,
): Promise<{ result?: WorkbenchResult; receipt: ActionReceipt }> {
  const started = performance.now();
  let result: WorkbenchResult | undefined;
  let validationPassed = false;
  let failure: string | undefined;

  try {
    if (plan.action.choice !== "buffer" || plan.call.tool !== "buffer") throw new Error("The buffer decision must select the Buffer operation.");
    if (plan.policy === "clarify" || (plan.policy === "review" && !approved)) throw new Error("The buffer decision requires context or explicit approval.");
    validateWorkbenchCall(plan.call, { layers });
    if (!plan.bindingHash || await hashBufferBinding(plan) !== plan.bindingHash) throw new Error("The bounded buffer decision or call changed. Request a fresh decision.");
    if (Object.values(plan.decisions).some((field) => field.disposition === "reject" || field.disposition === "clarify")) throw new Error("The bounded decision fields require context before execution.");
    if (!plan.runtimeHash || await hashRuntimeLayers(layers) !== plan.runtimeHash) throw new Error("Map state is stale or incomplete. Create a fresh plan with the full runtime layers.");
    validationPassed = true;
    result = await executeWorkbenchCall(plan.call, { layers });
  } catch (error) {
    failure = error instanceof Error ? error.message : "Spatial execution failed.";
  }

  const durationMs = Math.max(0, Math.round(performance.now() - started));
  const succeeded = result !== undefined;
  return {
    ...(result ? { result } : {}),
    receipt: createReceipt({
      id: existingReceipt?.id,
      timestamp: existingReceipt?.timestamp,
      stateHash: plan.stateHash,
      executionStateHash: plan.executionStateHash,
      runtimeHash: plan.runtimeHash,
      bindingHash: plan.bindingHash,
      model: plan.model,
      provenance: plan.provenance,
      decisionPayloads: plan.decisionPayloads,
      modelResponses: plan.modelResponses,
      decisions: plan.decisions,
      stateDiff: plan.stateDiff,
      semanticContext: plan.semanticContext,
      call: plan.call,
      inference: plan.inference,
      question: plan.question,
      probabilities: flattenProbabilities(plan.probabilities),
      confidence: plan.confidence,
      selectedAction: plan.action.choice,
      args: plan.call.args,
      validation: {
        valid: validationPassed,
        warnings: validationPassed || !failure ? [] : [failure],
      },
      execution: {
        success: succeeded,
        durationMs,
        status: succeeded ? "succeeded" : "failed",
        ...(failure ? { error: failure } : {}),
      },
    }),
  };
}

export type SpatialData = FeatureCollection<Geometry, GeoJsonProperties>;

async function hashRuntimeLayers(layers: ReadonlyMap<string, SpatialData>): Promise<string> {
  return hashSerialized(stableStringify([...layers.entries()].sort(([a], [b]) => a.localeCompare(b))));
}

async function hashBufferBinding(plan: BufferDecisionPlan): Promise<string> {
  return hashSerialized(stableStringify({ call: plan.call, decisions: plan.decisions, policy: plan.policy, runtimeHash: plan.runtimeHash, executionStateHash: plan.executionStateHash }));
}
