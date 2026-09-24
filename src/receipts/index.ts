export interface ActionReceipt {
  id: string;
  timestamp: string;
  stateHash: string;
  model: string;
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
