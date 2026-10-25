import type { JevMapState } from "../state/index.js";
import { ExecutionBoundaryError, type WorkbenchContext } from "../workbench/index.js";

export function decisionInputs(state: JevMapState) {
  const { intent, layers, selection, previousActions, activeResultLayerIds } = state;
  return { intent, layers, selection, previousActions, activeResultLayerIds };
}

/** Synchronous final check: no event-loop yield may separate this check from GIS. */
export function captureExecutionBoundary(plan: unknown, context: WorkbenchContext, state?: JevMapState): () => void {
  const serialize = () => JSON.stringify({ plan, state: state && decisionInputs(state),
    layers: [...context.layers], capabilities: context.capabilities && [...context.capabilities],
    limits: [context.maxFeatures, context.maxPairComparisons, context.maxExportBytes] });
  const snapshot = serialize();
  return () => {
    if (serialize() !== snapshot) throw new ExecutionBoundaryError("Decision or map state changed during validation. Request a fresh decision before execution.");
  };
}
