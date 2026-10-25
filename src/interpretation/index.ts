import type { ActionReceipt } from "../receipts/index.js";
import { workbenchDecisionValues } from "../workbench/index.js";

const DISPOSITION_LABELS: Record<string, string> = {
  apply: "Applied by policy",
  review: "Review required",
  clarify: "More context required",
  keep: "Kept · unchanged",
  reject: "Rejected",
  error: "Decision error",
};

/** A compact view of the canonical receipt; it does not create a second audit record. */
export function renderDecisionInterpretation(receipt: ActionReceipt): string {
  const source = record(receipt) ?? {};
  const fields = record(source.decisions);
  const guard = record(source.guard);
  const execution = record(source.execution) ?? {};
  const provenance = record(source.provenance) ?? {};
  const stateDiff = record(source.stateDiff) ?? {};
  const action = fields ? record(fields.action) : undefined;
  const fieldRows = fields && Object.keys(fields).length > 0
    ? Object.entries(fields).map(([id, field]) => renderField(id, field, guard, execution, stateDiff, receipt.call)).join("")
    : '<p class="interpretation-error" role="alert">No valid decision fields were recorded.</p>';
  const backend = typeof provenance.backend === "string" ? ({ jev: "Jev · hosted", julia: "Julia · local CPU", demo: "Demo · simulated" } as Record<string, string>)[provenance.backend] ?? provenance.backend : undefined;
  const originParts = [backend, provenance.model ?? source.model, provenance.runtime]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(escapeHtml);
  if (typeof provenance.version === "string" && provenance.version.length > 0) {
    const fullVersion = escapeHtml(provenance.version);
    originParts.push(provenance.version.length > 8 ? `<span title="${fullVersion}" aria-label="Full model version: ${fullVersion}">${escapeHtml(provenance.version.slice(0, 8))}…</span>` : fullVersion);
  }
  const origin = originParts.join(" · ");
  const receiptLink = typeof source.id === "string" && source.id.length > 0
    ? `<a class="interpretation-receipt" href="#receipt-${escapeHtml(encodeURIComponent(source.id))}">Inspect decision receipt ↗</a>`
    : '<span class="interpretation-error">Receipt detail is unavailable.</span>';

  return `<section class="interpretation" aria-label="Live decision interpretation">
    <div class="panel-kicker">LIVE INTERPRETATION</div>
    <h3>I interpreted your request as:</h3>
    ${origin ? `<p class="interpretation-provenance">${origin}</p>` : '<p class="interpretation-provenance">Model provenance unavailable</p>'}
    ${provenance.simulated === true ? '<p class="interpretation-note">Simulated decisions; no model inference.</p>' : ""}
    <div class="interpretation-fields">${fieldRows}</div>
    ${renderGuard(guard, action, execution)}
    ${renderCall(source.call, execution)}
    ${renderExecution(execution, source.selectedAction, action)}
    ${receiptLink}
  </section>`;
}

/** Request failures have no model decision or receipt to imply an execution occurred. */
export function renderInterpretationError(message: string): string {
  return `<section class="interpretation interpretation-failed" aria-label="Live decision interpretation">
    <div class="panel-kicker">LIVE INTERPRETATION</div>
    <h3>Interpretation unavailable</h3>
    <p class="interpretation-error" role="alert">${escapeHtml(message || "The decision request failed.")}</p>
    <p class="interpretation-note">No model decision was applied. No workbench operation ran.</p>
  </section>`;
}

function renderField(id: string, value: unknown, guard: Record<string, unknown> | undefined, execution: Record<string, unknown>, stateDiff: Record<string, unknown>, call: ActionReceipt["call"]): string {
  const field = record(value);
  if (!field) {
    return `<article class="interpretation-field" data-field-id="${escapeHtml(id)}" data-disposition="error">
      <h4>${escapeHtml(id)}</h4><p class="interpretation-error">Malformed decision field</p>
      <span class="disposition disposition-error">Decision error</span>
    </article>`;
  }
  const label = typeof field.label === "string" && field.label ? field.label : id;
  const disposition = typeof field.disposition === "string" && Object.hasOwn(DISPOSITION_LABELS, field.disposition)
    ? field.disposition : "error";
  let appliedDisposition = disposition;
  let appliedLabel = DISPOSITION_LABELS[disposition];
  if (guard?.fallback === true && call && !Object.hasOwn(workbenchDecisionValues(call), id)) {
    appliedDisposition = "keep";
    appliedLabel = "Not used by fallback";
  } else if (id === "action" && guard?.fallback === true && typeof guard.finalChoice === "string" && guard.finalChoice !== guard.originalChoice) {
    appliedDisposition = "fallback";
    appliedLabel = "Replaced by fallback";
  } else if (id === "action" && guard && !guard.finalChoice && Array.isArray(guard.rejected) && guard.rejected.some((item) => record(item)?.id === guard.originalChoice)) {
    appliedDisposition = "reject";
    appliedLabel = "Rejected by execution guard";
  } else if (guard && !guard.finalChoice && Array.isArray(guard.rejected) && guard.rejected.length && ["apply", "review"].includes(disposition)) {
    appliedDisposition = "reject";
    appliedLabel = "Not applied · execution blocked";
  } else if (disposition === "review" && execution.status === "succeeded" && Object.hasOwn(stateDiff, id)) {
    appliedDisposition = "apply";
    appliedLabel = "Applied after approval";
  }
  const finalDispositionChanged = appliedLabel !== DISPOSITION_LABELS[disposition];
  const optionId = typeof field.selectedOptionId === "string" ? field.selectedOptionId : undefined;
  const provenance = record(field.provenance);
  const modelOptionId = typeof provenance?.reportedOptionId === "string" ? provenance.reportedOptionId : optionId;
  const probabilities = record(field.probabilities) ?? {};
  const probability = modelOptionId ? validProbability(probabilities[modelOptionId]) : undefined;
  const selected = modelOptionId ? optionLabel(field, modelOptionId) : "No valid choice";
  const policyChoice = optionId && optionId !== modelOptionId
    ? `<p class="interpretation-policy-choice">Policy selected: <strong>${escapeHtml(optionLabel(field, optionId))}</strong> · ${validProbability(probabilities[optionId]) === undefined ? "probability unavailable" : `${formatPercent(probabilities[optionId] as number)} probability`}</p>` : "";
  const reason = typeof field.reason === "string" && field.reason ? `<p class="interpretation-reason">${escapeHtml(field.reason)}</p>` : "";
  const unchanged = disposition === "keep"
    ? `<p class="interpretation-current">Current value: ${escapeHtml(displayValue(field.currentValue))}</p>` : "";
  const confidence = validProbability(field.confidence);
  const effectiveConfidence = validProbability(field.effectiveConfidence);
  const optionLabels = record(field.optionLabels) ?? {};
  const optionIds = [...new Set([...Object.keys(optionLabels), ...Object.keys(probabilities)])];
  const distribution = optionIds.length > 0
    ? optionIds.map((candidate) => {
      const candidateProbability = validProbability(probabilities[candidate]);
      const candidateLabel = optionLabel(field, candidate);
      return `<div class="probability-row${candidate === modelOptionId ? " probability-selected" : ""}">
        <span>${escapeHtml(candidateLabel)}${candidate === modelOptionId ? ' <span class="sr-only">(model selection)</span>' : candidate === optionId ? ' <span class="sr-only">(policy selection)</span>' : ""}</span>
        ${candidateProbability === undefined ? '<span class="probability-unavailable">Unavailable</span>' : `<progress max="1" value="${candidateProbability}" aria-label="${escapeHtml(candidateLabel)} probability"></progress>`}
        <b>${candidateProbability === undefined ? "—" : formatPercent(candidateProbability)}</b>
      </div>`;
    }).join("")
    : '<p class="interpretation-error">Probability distribution unavailable.</p>';

  return `<article class="interpretation-field" data-field-id="${escapeHtml(id)}" data-disposition="${appliedDisposition}">
    <h4>${escapeHtml(label)}</h4>
    <div class="interpretation-selection"><strong>${escapeHtml(selected)}</strong><span class="interpretation-probability">${probability === undefined ? "Probability unavailable" : `${formatPercent(probability)} probability`}</span></div>
    <span class="disposition disposition-${appliedDisposition}">${appliedLabel}</span>
    ${policyChoice}${unchanged}
    ${provenance?.source === "deterministic" ? '<p class="interpretation-note">Single legal option · determined by the application; no model inference.</p>' : ""}
    <details class="interpretation-distribution"><summary>All option probabilities</summary>
      ${distribution}
      <p class="interpretation-note">Returned confidence: ${confidence === undefined ? "unavailable" : formatPercent(confidence)}</p>
      ${effectiveConfidence === undefined ? "" : `<p class="interpretation-note">Policy evidence confidence: ${formatPercent(effectiveConfidence)}</p>`}
      ${finalDispositionChanged ? `<p class="interpretation-note">Original field policy: ${DISPOSITION_LABELS[disposition]}</p>` : ""}
      ${reason}
    </details>
  </article>`;
}

function renderGuard(guard: Record<string, unknown> | undefined, action: Record<string, unknown> | undefined, execution: Record<string, unknown>): string {
  if (!guard) return "";
  const reportedOptionId = record(action?.provenance)?.reportedOptionId;
  const original = typeof reportedOptionId === "string" ? reportedOptionId : typeof guard.originalChoice === "string" ? guard.originalChoice : undefined;
  const final = typeof guard.finalChoice === "string" ? guard.finalChoice : undefined;
  const probabilities = record(action?.probabilities) ?? {};
  const fallback = guard.fallback === true;
  const choiceRow = (label: string, id: string) => {
    const probability = validProbability(probabilities[id]);
    return `<div><dt>${label}</dt><dd>${escapeHtml(optionLabel(action, id))}${probability === undefined ? "" : ` <span>${formatPercent(probability)} probability</span>`}</dd></div>`;
  };
  const rejected = Array.isArray(guard.rejected) ? guard.rejected.flatMap((item) => {
    const rejection = record(item);
    if (typeof rejection?.id !== "string") return [];
    const reason = typeof rejection.reason === "string" ? rejection.reason : "Rejected by execution guard.";
    return [`<li><strong>${escapeHtml(optionLabel(action, rejection.id))}</strong>: ${escapeHtml(reason)}</li>`];
  }).join("") : "";
  const finalLabel = fallback && execution.status === "succeeded" ? "Executed fallback" : fallback && execution.status === "pending" ? "Policy accepted fallback (review required)" : fallback ? "Policy accepted fallback" : "Policy accepted operation";
  return `<div class="interpretation-guard" aria-label="Application guard outcome">
    <dl>${original ? choiceRow("Model selected", original) : ""}${final ? choiceRow(finalLabel, final) : '<div><dt>Policy outcome</dt><dd>No operation accepted</dd></div>'}</dl>
    ${rejected ? `<ul class="interpretation-rejections">${rejected}</ul>` : ""}
  </div>`;
}

function renderExecution(execution: Record<string, unknown>, selectedAction: unknown, action: Record<string, unknown> | undefined): string {
  const status = typeof execution.status === "string" ? execution.status : execution.success === true ? "succeeded" : "not-run";
  const operation = typeof selectedAction === "string" ? optionLabel(action, selectedAction) : "Operation";
  const duration = typeof execution.durationMs === "number" && Number.isFinite(execution.durationMs) && execution.durationMs >= 0 ? ` in ${execution.durationMs} ms` : "";
  let message: string;
  switch (status) {
    case "succeeded": message = `${operation} completed${duration}.`; break;
    case "pending": message = "Awaiting approval. No workbench operation has run."; break;
    case "failed": message = `${operation} execution failed${duration}.`; break;
    case "not-run": message = "No workbench operation ran."; break;
    default: message = "Execution outcome unavailable.";
  }
  const error = typeof execution.error === "string" && execution.error ? `<p class="interpretation-note${status === "failed" ? " interpretation-error" : ""}">${escapeHtml(execution.error)}</p>` : "";
  return `<div class="interpretation-execution" data-execution-status="${escapeHtml(status)}"><h4>Deterministic execution</h4><p>${escapeHtml(message)}</p>${error}</div>`;
}

function renderCall(value: unknown, execution: Record<string, unknown>): string {
  if (value === undefined) return "";
  const call = record(value);
  if (typeof call?.tool !== "string" || !record(call.args)) return '<p class="interpretation-error">Workbench call is malformed.</p>';
  const label = execution.status === "succeeded" ? "EXECUTED WORKBENCH CALL" : execution.status === "failed" ? "ATTEMPTED WORKBENCH CALL" : "PROPOSED WORKBENCH CALL";
  return `<div class="call interpretation-call"><small>${label}</small><code>${escapeHtml(call.tool)}(${escapeHtml(displayValue(call.args))})</code></div>`;
}

function optionLabel(field: Record<string, unknown> | undefined, id: string): string {
  const labels = record(field?.optionLabels);
  if (typeof labels?.[id] === "string" && labels[id]) return labels[id] as string;
  if (field?.selectedOptionId === id && field.selectedValue !== undefined) return displayValue(field.selectedValue);
  return id;
}

function validProbability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function formatPercent(probability: number): string {
  return `${Math.round(probability * 1000) / 10}%`;
}

function displayValue(value: unknown): string {
  if (value === undefined) return "Unavailable";
  if (typeof value === "string") return value;
  if (value === null) return "None";
  try { return JSON.stringify(value) ?? "Unavailable"; } catch { return "Unavailable"; }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
