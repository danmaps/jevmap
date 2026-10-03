import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import * as maplibregl from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { createSpatialDecisionPlan, prepareSpatialDecision, spatialDecisionReceipt, executeSpatialDecision, type SpatialDecisionPlan } from "./analysis/workflow.js";
import type { SpatialData } from "./analysis/index.js";
import { createDecisionClient, DECISION_PROVIDERS, type DecisionProvider } from "./jev/providers.js";
import { renderDecisionInterpretation, renderInterpretationError } from "./interpretation/index.js";
import { estimateInferenceCost, formatCost, INFERENCE_RATES, summarizeProviderInference } from "./inference-cost.js";
import { MapLibreAdapter } from "./map/index.js";
import { toReceiptSummary, type ActionReceipt } from "./receipts/index.js";
import { parseFeatureCollection } from "./state/geojson.js";
import { summarizeFeatureCollection, type JevMapState, type LayerState } from "./state/index.js";
import demoPointsJson from "../public/demo/los-angeles-points.geojson?raw";

const demoPoints = parseFeatureCollection(demoPointsJson);

type ExampleId = "intersect" | "nearest" | "filter" | "select" | "export";
type ExampleDefinition = { id: ExampleId; label: string; description: string; prompt: string; note: string; layers: Array<{ id: string; name: string; data: SpatialData }> };

const laCoreArea: SpatialData = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Downtown study area", dataset: "Synthetic demo data" }, geometry: { type: "Polygon", coordinates: [[[-118.32, 34.02], [-118.20, 34.02], [-118.20, 34.10], [-118.32, 34.10], [-118.32, 34.02]]] } }] };
const laLandmarks: SpatialData = { type: "FeatureCollection", features: [
  { type: "Feature", properties: { name: "Civic landmark", kind: "civic" }, geometry: { type: "Point", coordinates: [-118.243, 34.053] } },
  { type: "Feature", properties: { name: "Park landmark", kind: "park" }, geometry: { type: "Point", coordinates: [-118.29, 34.09] } },
  { type: "Feature", properties: { name: "Transit landmark", kind: "transit" }, geometry: { type: "Point", coordinates: [-118.265, 34.04] } },
] };
const categorizedPoints: SpatialData = { type: "FeatureCollection", features: demoPoints.features.map((feature, index) => ({ ...feature, properties: { ...(feature.properties ?? {}), category: index % 2 === 0 ? "civic" : "residential" } })) };

const EXAMPLES: readonly ExampleDefinition[] = [
  { id: "intersect", label: "Intersect", description: "points × study area", prompt: "Intersect the Los Angeles demo points with the downtown study area.", note: "Example: two layers are loaded for a future intersection operation.", layers: [{ id: "la-demo-points", name: "Los Angeles demo points", data: demoPoints }, { id: "la-core-area", name: "Downtown study area", data: laCoreArea }] },
  { id: "nearest", label: "Nearest", description: "points → landmarks", prompt: "Find the nearest landmark for each Los Angeles demo point.", note: "Example: point and landmark layers are loaded for nearest-feature analysis.", layers: [{ id: "la-demo-points", name: "Los Angeles demo points", data: demoPoints }, { id: "la-landmarks", name: "Synthetic landmarks", data: laLandmarks }] },
  { id: "filter", label: "Filter", description: "category = civic", prompt: "Filter the Los Angeles demo points to civic features.", note: "Example: every point has a category field for deterministic filtering.", layers: [{ id: "la-demo-points", name: "Categorized demo points", data: categorizedPoints }] },
  { id: "select", label: "Select", description: "choose features", prompt: "Select the Hollywood and Downtown demo points.", note: "Example: the point layer is loaded for a map selection workflow.", layers: [{ id: "la-demo-points", name: "Los Angeles demo points", data: demoPoints }] },
  { id: "export", label: "Export", description: "write GeoJSON", prompt: "Export the Los Angeles demo points as GeoJSON.", note: "Example: the current layer is ready for the implemented export tool.", layers: [{ id: "la-demo-points", name: "Los Angeles demo points", data: demoPoints }] },
];

const COLORS = ["#e1a84b", "#f16b5b", "#82a9a1", "#b695ce", "#8fbf6e"];
const layerData = new Map<string, SpatialData>();
const layerStates = new Map<string, LayerState>();
const receiptHistory: ActionReceipt[] = [];
let activePlan: SpatialDecisionPlan | undefined;
let currentDecisionValues: Record<string, unknown> = {};
let currentSelection: JevMapState["selection"] = { featureIds: [] };
let pendingReceipt: ActionReceipt | undefined;
let isBusy = false;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root not found.");

app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="https://dannymcvey.com/">DANNY MCVEY</a>
  </header>
  <main class="shell">
    <section class="intro">
      <p class="eyebrow">LOS ANGELES · SPATIAL DECISION DEMO</p>
      <h1>Ask the map.<br /><em>Keep control.</em></h1>
      <p class="lede">Jev chooses. Spatial tools execute.<br />Explore every decision on the map.</p>
    </section>
    <section class="workspace">
      <div class="map-wrap"><div id="map" aria-label="Map of Los Angeles"></div></div>
      <aside class="panel">
        <div class="panel-header">
          <h2>Spatial task</h2>
          <button id="panel-toggle" type="button" aria-expanded="true" aria-controls="panel-content">Hide panel</button>
        </div>
        <div id="panel-content">
        <div class="panel-kicker">WORKBENCH / TASK</div>
        <section class="examples" aria-labelledby="examples-heading">
          <div class="examples-heading"><span id="examples-heading" class="panel-kicker">TRY A TOOL</span><small>load an example</small></div>
          <div class="example-grid">${EXAMPLES.map((example) => `<button class="example-button" type="button" data-example="${example.id}"><b>${example.label}</b><span>${example.description}</span></button>`).join("")}</div>
          <div id="example-status" class="example-status" aria-live="polite">Six bounded operations run through validated local tools.</div>
        </section>
        <label class="sr-only" for="goal">Spatial goal</label>
        <textarea id="goal">Create a 1 kilometer buffer around the Los Angeles demo points.</textarea>
        <label class="upload" for="geojson-files">Add GeoJSON layers<input id="geojson-files" type="file" accept=".json,.geojson,application/json,application/geo+json" multiple /></label>
        <div id="file-status" class="file-status" aria-live="polite">8 synthetic Los Angeles demo points are ready.</div>
        <a class="demo-download" href="${import.meta.env.BASE_URL}demo/los-angeles-points.geojson" download>Download demo GeoJSON ↗</a>
        <label class="provider-label" for="decision-provider">Decision provider</label>
        <select id="decision-provider">${DECISION_PROVIDERS.map((provider) => `<option value="${provider.id}">${provider.label}</option>`).join("")}</select>
        <p id="provider-note" class="metric-note">Jev uses the server-side proxy. Credentials stay on the server.</p>
        <button id="run" type="button">Interpret task <span>↗</span></button>
        <div id="result" class="result" aria-live="polite" aria-busy="false">
          <div class="result-empty">Choose a spatial goal and ask for a buffer.<br /><span>Every operation is validated before it runs.</span></div>
        </div>
        <section class="layers"><div class="panel-kicker">MAP STATE</div><div id="layer-list"></div></section>
        <section id="inference-metrics" class="inference-metrics" aria-label="Inference cost and speed"></section>
        <section id="receipt-section" class="receipts" hidden><div class="panel-kicker">DECISION RECEIPTS</div><div id="receipt-list"></div></section>
        <details class="architecture-panel">
          <summary>How this map works <span>↗</span></summary>
          <div class="loop"><span>MAP STATE</span><b>→</b><span>JEV DECISION</span><b>→</b><span>SPATIAL TOOLS</span></div>
          <p class="architecture-note">Designed around the <a href="https://workbench.dannymcvey.com/" target="_blank" rel="noopener noreferrer">Spatial Workbench</a> pattern: a decision model chooses a bounded action, validated spatial tools compute the geometry, and the map displays the result. This app implements that tool layer locally with Turf.js and renders it with MapLibre; the separate Spatial Workbench service is not connected.</p>
          <p class="footnote">Jev is the default; optional Julia decisions run locally and require review.</p>
        </details>
        </div>
      </aside>
    </section>
  </main>`;

const panelToggle = requiredElement<HTMLButtonElement>("#panel-toggle");
const panelContent = requiredElement<HTMLDivElement>("#panel-content");
panelToggle.addEventListener("click", () => {
  panelContent.hidden = !panelContent.hidden;
  panelToggle.setAttribute("aria-expanded", String(!panelContent.hidden));
  panelToggle.textContent = panelContent.hidden ? "Show panel" : "Hide panel";
});

const goalInput = requiredElement<HTMLTextAreaElement>("#goal");
const runButton = requiredElement<HTMLButtonElement>("#run");
const fileInput = requiredElement<HTMLInputElement>("#geojson-files");
const resultElement = requiredElement<HTMLDivElement>("#result");
const fileStatus = requiredElement<HTMLDivElement>("#file-status");
const layerList = requiredElement<HTMLDivElement>("#layer-list");
const receiptSection = requiredElement<HTMLElement>("#receipt-section");
const receiptList = requiredElement<HTMLDivElement>("#receipt-list");
const exampleStatus = requiredElement<HTMLDivElement>("#example-status");

// Emit the worker and its dependencies under Vite's configured deployment base.
maplibregl.setWorkerUrl(mapWorkerUrl);
const map = new maplibregl.Map({
  container: "map",
  center: [-118.29, 34.045],
  zoom: 10.5,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
      },
    },
    layers: [{
      id: "osm-dark",
      type: "raster",
      source: "osm",
      paint: {
        "raster-saturation": -1,
        // Invert luminance for dark land and muted, light linework.
        "raster-brightness-min": 0.32,
        "raster-brightness-max": 0.055,
        "raster-contrast": 0.15,
      },
    }],
  },
});
const mapAdapter = new MapLibreAdapter(map, () => {
  const panel = requiredElement<HTMLElement>(".panel").getBoundingClientRect();
  const bottomPanel = window.innerWidth <= 760 && window.innerHeight > 520;
  return bottomPanel
    ? { top: Math.min(240, window.innerHeight * .29), bottom: window.innerHeight - panel.top + 16, left: 28, right: 28 }
    : { top: Math.min(260, window.innerHeight * .3), bottom: 60, left: 48, right: window.innerWidth - panel.left + 32 };
});
const mapReady = new Promise<void>((resolve) => {
  map.once("load", () => {
    registerLayer("la-demo-points", "Los Angeles demo points", demoPoints, true);
    renderLayers();
    resolve();
  });
});

const providerSelect = requiredElement<HTMLSelectElement>("#decision-provider");
providerSelect.addEventListener("change", () => {
  finishPendingDecision("The decision provider changed. Request a fresh interpretation.");
  activePlan = undefined;
  requiredElement<HTMLElement>("#provider-note").textContent = providerSelect.value === "julia"
    ? "Experimental Julia decisions run through the local CPU service and require review."
    : "Jev uses the server-side proxy. Credentials stay on the server.";
  renderInferenceMetrics();
});
renderInferenceMetrics();

runButton.addEventListener("click", () => void runAnalysis());
fileInput.addEventListener("change", () => void loadFiles());
document.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((button) => {
  button.addEventListener("click", () => void loadExample(button.dataset.example as ExampleId));
});

async function loadExample(id: ExampleId): Promise<void> {
  const example = EXAMPLES.find((item) => item.id === id);
  if (!example) return;
  await mapReady;
  finishPendingDecision("The example changed the map state.");
  for (const layerId of layerStates.keys()) mapAdapter.removeGeoJSONLayer(layerId);
  layerData.clear();
  layerStates.clear();
  receiptHistory.length = 0;
  activePlan = undefined;
  pendingReceipt = undefined;
  currentDecisionValues = {};
  currentSelection = { featureIds: [] };
  for (const layer of example.layers) registerLayer(layer.id, layer.name, layer.data);
  const firstExtent = [...layerStates.values()].find((layer) => layer.extent)?.extent;
  if (firstExtent) mapAdapter.fitBounds(firstExtent);
  goalInput.value = example.prompt;
  fileStatus.textContent = `${example.layers.length} example layer${example.layers.length === 1 ? "" : "s"} loaded.`;
  exampleStatus.textContent = example.note;
  resultElement.innerHTML = `<div class="result-empty">${example.note}<br /><span>Ask Jev to choose and run this Workbench operation.</span></div>`;
  renderReceipts();
}

async function runAnalysis(): Promise<void> {
  const intent = goalInput.value.trim();
  if (!intent) { showMessage("Enter a spatial goal first.", "error"); return; }
  finishPendingDecision("A newer decision replaced this review.");
  activePlan = undefined;
  setBusy(true);
  showMessage("Preparing semantic map context and bounded choices…");
  try {
    await mapReady;
    const state = buildState(intent);
    const client = createDecisionClient(providerSelect.value as DecisionProvider, {
      jevModel: import.meta.env.VITE_TYPESAFE_MODEL || "jev-latest",
      juliaEndpoint: import.meta.env.VITE_JULIA_ENDPOINT,
    });
    const proposal = await createSpatialDecisionPlan(state, client, { layers: layerData }, currentDecisionValues);
    const plan = await prepareSpatialDecision(proposal, buildState(goalInput.value.trim()), { layers: layerData });
    activePlan = plan;
    let receipt = spatialDecisionReceipt(plan);
    receiptHistory.unshift(receipt);
    if (plan.policy === "execute") {
      const outcome = await executeSpatialDecision(plan, buildState(goalInput.value.trim(), receipt.id), { layers: layerData }, { receipt });
      receipt = outcome.receipt;
      activePlan = outcome.plan;
      receiptHistory[0] = receipt;
      if (outcome.result) applyResult(outcome.plan, outcome.result, receipt);
    }
    pendingReceipt = receipt.execution.status === "pending" ? receipt : undefined;
    renderReceipts();
    showReceipt(receipt, !!pendingReceipt);
    renderInferenceMetrics(activePlan);
  } catch (error) {
    showWorkflowError(error instanceof Error ? error.message : "JevMap could not complete this request.");
  } finally { setBusy(false); }
}

async function approvePendingPlan(): Promise<void> {
  const plan = activePlan;
  const receipt = pendingReceipt;
  if (!plan || !receipt || isBusy) return;
  setBusy(true);
  try {
    const outcome = await executeSpatialDecision(plan, buildState(goalInput.value.trim(), receipt.id), { layers: layerData }, { approved: true, receipt });
    const index = receiptHistory.findIndex((item) => item.id === receipt.id);
    if (index >= 0) receiptHistory[index] = outcome.receipt;
    pendingReceipt = outcome.receipt.execution.status === "pending" ? outcome.receipt : undefined;
    activePlan = outcome.plan;
    if (outcome.result) applyResult(outcome.plan, outcome.result, outcome.receipt);
    renderReceipts();
    showReceipt(outcome.receipt, !!pendingReceipt);
  } catch (error) {
    showWorkflowError(error instanceof Error ? error.message : "The approval could not be completed.");
  } finally { setBusy(false); }
}

function applyResult(plan: SpatialDecisionPlan, result: import("./workbench/index.js").WorkbenchResult, receipt: ActionReceipt): void {
  Object.assign(currentDecisionValues, structuredClone(receipt.stateDiff ?? {}));
  currentDecisionValues.action = result.tool;
  if (result.tool === "export") {
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.data, null, 2)], { type: "application/geo+json" }));
    link.href = url; link.download = "jevmap-result.geojson"; link.click(); URL.revokeObjectURL(url);
  } else {
    const resultId = `${result.layerId}-${receipt.id.slice(0, 8)}`;
    registerLayer(resultId, `${result.tool} result`, result.data, true);
    const layer = layerStates.get(resultId)!;
    layer.provenance = { tool: result.tool, sourceLayerIds: plan.call ? [plan.call.args.layerId, ...("overlayLayerId" in plan.call.args ? [plan.call.args.overlayLayerId] : "targetLayerId" in plan.call.args ? [plan.call.args.targetLayerId] : [])] : [], receiptId: receipt.id };
    if (result.tool === "select" && plan.call?.tool === "select") currentSelection = { layerId: plan.call.args.layerId, featureIds: [...plan.call.args.featureIds] };
  }
}

function showReceipt(receipt: ActionReceipt, allowApproval = false): void {
  resultElement.innerHTML = renderDecisionInterpretation(receipt);
  resultElement.scrollIntoView({ block: "start" });
  if (allowApproval && receipt.execution.status === "pending") {
    const approve = document.createElement("button");
    approve.type = "button"; approve.className = "approve-button"; approve.textContent = "Approve & run proposed call";
    approve.addEventListener("click", () => void approvePendingPlan()); resultElement.append(approve);
  }
  resultElement.querySelector<HTMLAnchorElement>('a[href^="#receipt-"]')?.addEventListener("click", () => {
    const details = document.getElementById(`receipt-${receipt.id}`) as HTMLDetailsElement | null;
    if (details) details.open = true;
  });
}

function showWorkflowError(message: string): void {
  const latest = receiptHistory[0];
  if (activePlan && latest) {
    showReceipt(latest, latest.execution.status === "pending");
    const error = document.createElement("p");
    error.className = "interpretation-error";
    error.setAttribute("role", "alert");
    error.textContent = message;
    resultElement.append(error);
  } else resultElement.innerHTML = renderInterpretationError(message);
}

async function loadFiles(): Promise<void> {
  const files = [...(fileInput.files ?? [])];
  if (files.length === 0) return;
  setBusy(true);
  fileStatus.textContent = `Reading ${files.length} file(s)…`;
  fileStatus.classList.remove("error");

  try {
    await mapReady;
    let added = 0;
    const errors: string[] = [];
    for (const file of files) {
      try {
        const data = parseFeatureCollection(await file.text());
        const name = file.name.replace(/\.(geo)?json$/i, "") || "GeoJSON layer";
        const id = uniqueLayerId(name);
        registerLayer(id, name, data, true);
        added += 1;
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : "Invalid GeoJSON."}`);
      }
    }
    fileStatus.textContent = errors.length
      ? `${added} layer(s) added. ${errors.join(" ")}`
      : `${added} layer(s) added.`;
    if (errors.length) fileStatus.classList.add("error");
  } finally {
    fileInput.value = "";
    setBusy(false);
  }
}

function finishPendingDecision(reason: string): void {
  if (!pendingReceipt) return;
  const index = receiptHistory.findIndex((item) => item.id === pendingReceipt?.id);
  if (index >= 0) {
    receiptHistory[index] = {
      ...pendingReceipt,
      validation: { valid: false, warnings: [reason] },
      execution: { success: false, durationMs: 0, status: "not-run", error: reason },
    };
    renderReceipts();
    showReceipt(receiptHistory[index]!);
  }
  pendingReceipt = undefined;
}

function registerLayer(id: string, name: string, data: SpatialData, fit = false): void {
  const layer = summarizeFeatureCollection(id, name, data);
  layerData.set(id, data);
  layerStates.set(id, layer);
  mapAdapter.addGeoJSONLayer(id, data, COLORS[(layerStates.size - 1) % COLORS.length] ?? COLORS[0] ?? "#e1a84b");
  renderLayers();
  if (fit && layer.extent) mapAdapter.fitBounds(layer.extent);
}

function buildState(intent: string, excludeReceiptId?: string): JevMapState {
  return {
    intent,
    viewport: mapAdapter.getViewport(),
    layers: [...layerStates.values()],
    selection: { ...currentSelection, featureIds: [...currentSelection.featureIds] },
    previousActions: receiptHistory
      .filter((receipt) => receipt.id !== excludeReceiptId)
      .map(toReceiptSummary),
  };
}

function renderLayers(): void {
  layerList.replaceChildren();
  for (const layer of layerStates.values()) {
    const row = document.createElement("div");
    row.className = "layer";
    const name = document.createElement("b");
    const dot = document.createElement("i");
    dot.className = "dot";
    dot.style.backgroundColor = COLORS[[...layerStates.keys()].indexOf(layer.id) % COLORS.length] ?? "#e1a84b";
    name.append(dot, document.createTextNode(layer.name));
    const count = document.createElement("span");
    count.textContent = `${layer.featureCount} feature${layer.featureCount === 1 ? "" : "s"}`;
    row.append(name, count);
    layerList.append(row);
  }
}

function renderReceipts(): void {
  receiptSection.hidden = receiptHistory.length === 0;
  receiptList.replaceChildren();
  for (const receipt of receiptHistory) {
    const details = document.createElement("details");
    details.className = "receipt-card";
    details.id = `receipt-${receipt.id}`;
    const summary = document.createElement("summary");
    const state = receipt.execution.status ?? (receipt.execution.success ? "succeeded" : "not-run");
    summary.textContent = `${receipt.selectedAction} · ${state} · ${Math.round(receipt.confidence * 100)}%`;
    const payload = document.createElement("pre");
    payload.textContent = JSON.stringify(receipt, null, 2);
    details.append(summary, payload);
    receiptList.append(details);
  }
}

function renderInferenceMetrics(plan?: SpatialDecisionPlan): void {
  const metrics = requiredElement<HTMLElement>("#inference-metrics");
  const wasOpen = metrics.querySelector("details")?.open ?? false;
  const { inputTokens, isJev, providerName, cost } = summarizeProviderInference(plan, providerSelect.value as DecisionProvider);
  const latency = plan ? `${(plan.inference.durationMs / 1000).toFixed(2)} s` : "Run to measure";
  const tokenBudget = inputTokens ?? 2000;
  metrics.innerHTML = `
    <div class="panel-kicker">INFERENCE / COST & SPEED</div>
    <div class="metric-cards">
      <div><small>${plan ? `${providerName} request time` : `${providerName} request time`}</small><strong>${latency}</strong></div>
      <div><small>${isJev ? plan ? "Estimated API cost" : "Illustrative API cost" : "API inference charge"}</small><strong>${formatCost(cost)}</strong></div>
    </div>
    <p class="metric-note">${plan ? "Measured round trip, including service/network and proxy. GIS execution is timed separately." : isJev ? "Run Jev to measure hosted inference; the initial cost assumes 2,000 input tokens." : "Julia has no API charge. Local CPU, memory and electricity costs are unmeasured."}</p>
    <details class="cost-comparison" ${wasOpen ? "open" : ""}>
      <summary>Compare provider costs</summary>
      <table><caption>Illustrative cost per decision request</caption><thead><tr><th scope="col">Model</th><th scope="col">USD / call</th><th scope="col">Time</th></tr></thead><tbody>
        ${INFERENCE_RATES.map((rate) => {
          const selected = rate.name === providerName;
          const rowCost = selected ? cost : estimateInferenceCost(tokenBudget, 300, rate);
          return `<tr><th scope="row"><a href="${rate.source}" target="_blank" rel="noopener noreferrer">${rate.name}</a>${selected ? " · selected" : ""}</th><td>${formatCost(rowCost)}</td><td>${selected ? latency : "Not measured"}</td></tr>`;
        }).join("")}
      </tbody></table>
      <p class="metric-note">${isJev && inputTokens === undefined ? "Jev did not report token usage; its cost is unavailable." : isJev ? `${tokenBudget.toLocaleString()} input tokens${plan ? " reported by Jev" : " assumed"}.` : "Julia 1 cost is $0 for API inference; local CPU, memory, and electricity costs are not measured."} Hosted model examples use the same input count plus an assumed 300 output tokens. Different tokenizers and prompts can change estimates.</p>
      <p class="metric-note">No Luna or Sonnet request was run here; their latency and decision quality on this map task are unbenchmarked.</p>
      <p class="metric-note"><a href="https://evals.typesafe.ai/" target="_blank" rel="noopener noreferrer">Published workflow context ↗</a>: TypeSafe reports mean times of 0.4 s for Jev, 12.9 s for “Luna,” and 78.1 s for Sonnet 5 across four larger workflows at default reasoning. These are vendor results, not predictions for this call; the overview does not specify Luna’s version.</p>
      <p class="metric-note">Jev pricing checked September 24, 2026. Julia 1 is local and has no API charge; model links above cite the relevant provider/runtime source.</p>
    </details>`;
}

function showMessage(message: string, style = ""): void {
  resultElement.replaceChildren();
  const content = document.createElement("div");
  content.className = `result-empty ${style}`;
  content.textContent = message;
  resultElement.append(content);
}

function setBusy(busy: boolean): void {
  isBusy = busy;
  runButton.disabled = busy;
  fileInput.disabled = busy;
  providerSelect.disabled = busy;
  goalInput.disabled = busy;
  document.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((button) => { button.disabled = busy; });
  resultElement.setAttribute("aria-busy", String(busy));
  runButton.querySelector("span")?.replaceChildren(document.createTextNode(busy ? "…" : "↗"));
}

function uniqueLayerId(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "geojson-layer";
  let id = base;
  let suffix = 2;
  while (layerData.has(id)) id = `${base}-${suffix++}`;
  return id;
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing page element: ${selector}`);
  return element;
}
