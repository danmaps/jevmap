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
import { createReceipt, type ActionReceipt } from "../receipts/index.js";
import type { JevMapState } from "../state/index.js";
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
}

export async function createBufferDecisionPlan(
  state: JevMapState,
  client: DecisionClient,
  policy?: DecisionPolicy,
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

  const inferenceStarted = performance.now();
  const response = await client.ask(state as unknown as Record<string, unknown>, questions);
  const inferenceDurationMs = Math.max(0, Math.round(performance.now() - inferenceStarted));
  const action = parseChoiceAnswer(response.answers.action, "action", questions.action.criteria);
  const layer = parseChoiceAnswer(response.answers.layer, "layer", questions.layer.criteria);
  const distance = parseChoiceAnswer(response.answers.distance, "distance", questions.distance.criteria);
  const distanceCandidate = DEFAULT_DISTANCE_CANDIDATES.find((candidate) => candidate.id === distance.choice);
  if (!distanceCandidate) throw new Error("The selected buffer distance is not available.");
  const confidence = Math.min(action.confidence, layer.confidence, distance.confidence);
  return {
    model: response.model,
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
    policy: applyDecisionPolicy(confidence, policy),
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
    model: plan.model,
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
): Promise<{ result?: WorkbenchResult; receipt: ActionReceipt }> {
  const started = performance.now();
  let result: WorkbenchResult | undefined;
  let validationPassed = false;
  let failure: string | undefined;

  try {
    validateWorkbenchCall(plan.call, { layers });
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
      model: plan.model,
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
