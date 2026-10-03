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
    ...structuredClone(input),
    id: input.id ?? createReceiptId(),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}

/** Receipt IDs must also work when the demo is opened over plain HTTP on a LAN. */
function createReceiptId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
