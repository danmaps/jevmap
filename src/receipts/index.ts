import type { DecisionFieldResult } from "../decisions/index.js";
import type { DecisionProvenance } from "../jev/providers.js";

export interface DecisionGuardReceipt {
  originalChoice: string;
  finalChoice?: string;
  ranking: Array<{ id: string; probability: number }>;
  rejected: Array<{ id: string; reason: string }>;
  fallback: boolean;
}

export interface ActionReceipt {
  id: string;
  timestamp: string;
  stateHash: string;
  executionStateHash?: string;
  runtimeHash?: string;
  bindingHash?: string;
  model: string;
  provenance?: DecisionProvenance;
  semanticContext?: Record<string, unknown>;
  decisions?: Record<string, DecisionFieldResult>;
  stateDiff?: Record<string, unknown>;
  guard?: DecisionGuardReceipt;
  call?: import("../workbench/index.js").WorkbenchCall;
  decisionPayloads?: import("../jev/index.js").SystemOneRequest[];
  modelResponses?: import("../jev/index.js").SystemOneResponse[];
  inference?: { durationMs: number; inputTokens?: number; outputTokens?: number };
  question: string;
  probabilities: Record<string, number>;
  confidence: number;
  selectedAction: string;
  args: unknown;
  validation: {
    valid: boolean;
    warnings: string[];
  };
  execution: {
    success: boolean;
    durationMs: number;
    status?: "pending" | "not-run" | "succeeded" | "failed";
    error?: string;
  };
}

export interface CreateReceiptInput extends Omit<ActionReceipt, "id" | "timestamp"> {
  id?: string;
  timestamp?: string;
}

export function createReceipt(input: CreateReceiptInput): ActionReceipt {
  return {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}

export function toReceiptSummary(receipt: ActionReceipt): {
  id: string;
  selectedAction: string;
  confidence: number;
  success: boolean;
} {
  return {
    id: receipt.id,
    selectedAction: receipt.selectedAction,
    confidence: receipt.confidence,
    success: receipt.execution.success,
  };
}
