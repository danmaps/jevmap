import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import * as maplibregl from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import {
  createBufferDecisionPlan,
  createPendingDecisionReceipt,
  executeBufferDecision,
  hashDecisionInputs,
  type BufferDecisionPlan,
  type SpatialData,
} from "./analysis/index.js";
import { JevProxyClient } from "./jev/proxy-client.js";
import { estimateInferenceCost, formatCost, INFERENCE_RATES } from "./inference-cost.js";
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
  { id: "intersect", label: "Intersect", description: "points × study area", prompt: "Intersect the Los Angeles demo points with the downtown study area.", note: "Preview: two layers are loaded for a future intersection operation.", layers: [{ id: "la-demo-points", name: "Los Angeles demo points", data: demoPoints }, { id: "la-core-area", name: "Downtown study area", data: laCoreArea }] },
  { id: "nearest", label: "Nearest", description: "points → landmarks", prompt: "Find the nearest landmark for each Los Angeles demo point.", note: "Preview: point and landmark layers are loaded for nearest-feature analysis.", layers: [{ id: "la-demo-points", name: "Los Angeles demo points", data: demoPoints }, { id: "la-landmarks", name: "Synthetic landmarks", data: laLandmarks }] },
  { id: "filter", label: "Filter", description: "category = civic", prompt: "Filter the Los Angeles demo points to civic features.", note: "Preview: every point has a category field for deterministic filtering.", layers: [{ id: "la-demo-points", name: "Categorized demo points", data: categorizedPoints }] },
  { id: "select", label: "Select", description: "choose features", prompt: "Select the Hollywood and Downtown demo points.", note: "Preview: the point layer is loaded for a map selection workflow.", layers: [{ id: "la-demo-points", name: "Los Angeles demo points", data: demoPoints }] },
  { id: "export", label: "Export", description: "write GeoJSON", prompt: "Export the Los Angeles demo points as GeoJSON.", note: "Preview: the current layer is ready for the implemented export tool.", layers: [{ id: "la-demo-points", name: "Los Angeles demo points", data: demoPoints }] },
];

const COLORS = ["#e1a84b", "#f16b5b", "#82a9a1", "#b695ce", "#8fbf6e"];
const layerData = new Map<string, SpatialData>();
const layerStates = new Map<string, LayerState>();
const receiptHistory: ActionReceipt[] = [];
let activePlan: BufferDecisionPlan | undefined;
let pendingReceipt: ActionReceipt | undefined;
let isBusy = false;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root not found.");

app.innerHTML = `
  <header class="topbar">
    <div class="brand"><a href="https://dannymcvey.com/">DANNY MCVEY</a> <span>/ <a href="/jevmap/">JEVMAP</a></span></div>
    <span class="status"><i></i><span id="mode-label">JEV SERVER PROXY</span></span>
  </header>
  <main class="shell">
    <section class="intro">
      <p class="eyebrow">LOS ANGELES · SPATIAL DECISION DEMO</p>
      <h1>Ask the map.<br /><em>Keep control.</em></h1>
      <p class="lede">Jev chooses. Spatial tools execute.<br />Explore every decision on the map.</p>
    </section>
    <section class="workspace">
      <div class="map-wrap"><div id="map" aria-label="JevMap demo map"></div><div class="map-label">LOS ANGELES <span> / LIVE MAP</span></div></div>
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
          <div id="example-status" class="example-status" aria-live="polite">Buffer is the executable demo; these buttons preview the other Workbench tools.</div>
        </section>
        <label class="sr-only" for="goal">Spatial goal</label>
        <textarea id="goal">Create a 1 kilometer buffer around the Los Angeles demo points.</textarea>
        <label class="upload" for="geojson-files">Add GeoJSON layers<input id="geojson-files" type="file" accept=".json,.geojson,application/json,application/geo+json" multiple /></label>
        <div id="file-status" class="file-status" aria-live="polite">8 synthetic Los Angeles demo points are ready.</div>
        <a class="demo-download" href="${import.meta.env.BASE_URL}demo/los-angeles-points.geojson" download>Download demo GeoJSON ↗</a>
        <button id="run" type="button">Ask Jev <span>↗</span></button>
        <div id="result" class="result" aria-live="polite" aria-busy="false">
          <div class="result-empty">Choose a spatial goal and ask for a buffer.<br /><span>Every operation is validated before it runs.</span></div>
        </div>
        <section class="layers"><div class="panel-kicker">MAP STATE</div><div id="layer-list"></div></section>
        <section id="inference-metrics" class="inference-metrics" aria-label="Inference cost and speed"></section>
        <section id="receipt-section" class="receipts" hidden><div class="panel-kicker">DECISION RECEIPTS</div><div id="receipt-list"></div></section>
        <details class="architecture-panel">
          <summary>How this map works <span>↗</span></summary>
          <div class="loop"><span>MAP STATE</span><b>→</b><span>JEV DECISION</span><b>→</b><span>SPATIAL TOOLS</span></div>
          <p class="architecture-note">Designed around the <a href="https://workbench.dannymcvey.com/" target="_blank" rel="noopener noreferrer">Spatial Workbench</a> pattern: Jev chooses a bounded action, validated spatial tools compute the geometry, and the map displays the result. This demo implements that tool layer locally with Turf.js and renders it with MapLibre; the separate Spatial Workbench service is not connected.</p>
          <p class="footnote">Jev runs through a server-side proxy. The API key stays out of your browser.</p>
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
const modeLabel = requiredElement<HTMLSpanElement>("#mode-label");
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

const jevClient = new JevProxyClient({ model: import.meta.env.VITE_TYPESAFE_MODEL || "jev-latest" });
modeLabel.textContent = "JEV SERVER PROXY";
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
  for (const layer of example.layers) registerLayer(layer.id, layer.name, layer.data);
  const firstExtent = [...layerStates.values()].find((layer) => layer.extent)?.extent;
  if (firstExtent) mapAdapter.fitBounds(firstExtent);
  goalInput.value = example.prompt;
  fileStatus.textContent = `${example.layers.length} example layer${example.layers.length === 1 ? "" : "s"} loaded.`;
  exampleStatus.textContent = example.note;
  resultElement.innerHTML = `<div class="result-empty">${example.note}<br /><span>Ask Jev is currently wired to the buffer slice.</span></div>`;
  renderReceipts();
}

async function runAnalysis(): Promise<void> {
  const intent = goalInput.value.trim();
  if (!intent) {
    showMessage("Enter a spatial goal first.", "error");
    return;
  }

  finishPendingDecision("A newer decision replaced this review.");
  activePlan = undefined;
  setBusy(true);
  showMessage("Preparing map state and bounded choices…");

  try {
    await mapReady;
    const state = buildState(intent);
    const plan = await createBufferDecisionPlan(state, jevClient);
    activePlan = plan;

    if (plan.policy === "execute") {
      showPlan(plan, "High confidence. Executing the validated buffer call.");
      const outcome = await executeBufferDecision(plan, layerData);
      receiptHistory.unshift(outcome.receipt);
      if (outcome.result) addResultLayer(plan, outcome.result.data);
      renderReceipts();
      showPlan(
        plan,
        outcome.receipt.execution.success
          ? `Buffer completed in ${outcome.receipt.execution.durationMs} ms.`
          : `Execution failed: ${outcome.receipt.execution.error ?? "Unknown error."}`,
      );
      return;
    }

    const receipt = createPendingDecisionReceipt(plan);
    receiptHistory.unshift(receipt);
    renderReceipts();
    if (plan.policy === "review") {
      pendingReceipt = receipt;
      showPlan(plan, "Review the decision, then approve the deterministic operation.", true);
    } else {
      showPlan(plan, "Jev needs more context. No spatial operation was run.");
    }
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "JevMap could not complete this request.", "error");
  } finally {
    setBusy(false);
  }
}

async function approvePendingPlan(): Promise<void> {
  const plan = activePlan;
  const receipt = pendingReceipt;
  if (!plan || !receipt || isBusy) return;

  setBusy(true);
  showPlan(plan, "Checking that the map state has not changed…");
  try {
    await mapReady;
    const currentState = buildState(goalInput.value.trim(), receipt.id);
    if ((await hashDecisionInputs(currentState)) !== plan.executionStateHash) {
      const index = receiptHistory.findIndex((item) => item.id === receipt.id);
      if (index >= 0) {
        receiptHistory[index] = {
          ...receipt,
          validation: { valid: false, warnings: ["The map state changed after this decision."] },
          execution: { success: false, durationMs: 0, status: "not-run", error: "Ask Jev again before execution." },
        };
      }
      pendingReceipt = undefined;
      renderReceipts();
      showPlan(plan, "Map state changed. Ask again to get a fresh decision.");
      return;
    }

    const outcome = await executeBufferDecision(plan, layerData, receipt);
    const index = receiptHistory.findIndex((item) => item.id === receipt.id);
    if (index >= 0) receiptHistory[index] = outcome.receipt;
    pendingReceipt = undefined;
    if (outcome.result) addResultLayer(plan, outcome.result.data);
    renderReceipts();
    showPlan(
      plan,
      outcome.receipt.execution.success
        ? `Approved buffer completed in ${outcome.receipt.execution.durationMs} ms.`
        : `Execution failed: ${outcome.receipt.execution.error ?? "Unknown error."}`,
    );
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "The approval could not be completed.", "error");
  } finally {
    setBusy(false);
  }
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

function addResultLayer(plan: BufferDecisionPlan, data: SpatialData): void {
  const source = layerStates.get(plan.layer.choice);
  const name = `${source?.name ?? plan.layer.choice} buffer · ${plan.distanceCandidate.label}`;
  const resultId = `${plan.call.args.layerId}__buffer_${plan.distanceCandidate.id}`;
  registerLayer(resultId, name, data, true);
}

function buildState(intent: string, excludeReceiptId?: string): JevMapState {
  return {
    intent,
    viewport: mapAdapter.getViewport(),
    layers: [...layerStates.values()],
    selection: { featureIds: [] },
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
    const summary = document.createElement("summary");
    const state = receipt.execution.status ?? (receipt.execution.success ? "succeeded" : "not-run");
    summary.textContent = `${receipt.selectedAction} · ${state} · ${Math.round(receipt.confidence * 100)}%`;
    const payload = document.createElement("pre");
    payload.textContent = JSON.stringify(receipt, null, 2);
    details.append(summary, payload);
    receiptList.append(details);
  }
}

function showPlan(plan: BufferDecisionPlan, message: string, allowApproval = false): void {
  renderInferenceMetrics(plan);
  resultElement.replaceChildren();
  const decision = document.createElement("div");
  decision.className = "decision";

  const header = document.createElement("div");
  header.className = "decision-head";
  const mark = document.createElement("span");
  mark.className = `check ${plan.policy === "clarify" ? "check-muted" : ""}`;
  mark.textContent = plan.policy === "clarify" ? "?" : "✓";
  const heading = document.createElement("div");
  const source = document.createElement("small");
  source.textContent = plan.model === "local-demo" ? "LOCAL SIMULATION" : "JEV DECISION";
  const action = document.createElement("strong");
  action.textContent = "Buffer";
  heading.append(source, action);
  const confidence = document.createElement("b");
  confidence.textContent = `${Math.round(plan.confidence * 100)}%`;
  header.append(mark, heading, confidence);

  const description = document.createElement("p");
  const sourceLayer = layerStates.get(plan.layer.choice);
  description.textContent = `${plan.distanceCandidate.label} around ${sourceLayer?.name ?? plan.layer.choice}.`;

  const call = document.createElement("div");
  call.className = "call";
  const callLabel = document.createElement("small");
  callLabel.textContent = "VALIDATED TOOL CALL";
  const callCode = document.createElement("code");
  callCode.textContent = `buffer(${plan.call.args.layerId}, ${plan.call.args.distanceMeters}m)`;
  call.append(callLabel, callCode);

  const probabilities = document.createElement("div");
  probabilities.className = "probability-groups";
  appendProbabilityGroup(probabilities, "Operation", plan.action.probabilities, (key) => key);
  appendProbabilityGroup(probabilities, "Input layer", plan.layer.probabilities, (key) => layerStates.get(key)?.name ?? key);
  appendProbabilityGroup(probabilities, "Buffer distance", plan.distance.probabilities, (key) => {
    return key === plan.distance.choice
      ? plan.distanceCandidate.label
      : key === "1km"
        ? "1 kilometer"
        : `${key.replace(/m$/, "")} meters`;
  });

  const status = document.createElement("div");
  status.className = `decision-status ${plan.policy === "clarify" ? "error" : ""}`;
  status.textContent = message;
  decision.append(header, description, call, probabilities, status);

  if (allowApproval) {
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "approve-button";
    approve.textContent = "Approve & run buffer";
    approve.addEventListener("click", () => void approvePendingPlan());
    decision.append(approve);
  }

  resultElement.append(decision);
}

function renderInferenceMetrics(plan?: BufferDecisionPlan): void {
  const metrics = requiredElement<HTMLElement>("#inference-metrics");
  const wasOpen = metrics.querySelector("details")?.open ?? false;
  const inputTokens = plan ? plan.inference.inputTokens : 2000;
  const isJev = !plan || /^jev(?:-|$)/i.test(plan.model);
  const cost = inputTokens === undefined || !isJev ? undefined : estimateInferenceCost(inputTokens, 0, INFERENCE_RATES[0]);
  const latency = plan ? `${(plan.inference.durationMs / 1000).toFixed(2)} s` : "Run to measure";
  const tokenBudget = inputTokens ?? 2000;
  metrics.innerHTML = `
    <div class="panel-kicker">INFERENCE / COST & SPEED</div>
    <div class="metric-cards">
      <div><small>${plan ? "This Jev request" : "Jev request time"}</small><strong>${latency}</strong></div>
      <div><small>${plan ? "Estimated API cost" : "Example API cost"}</small><strong>${formatCost(cost)}</strong></div>
    </div>
    <p class="metric-note">${plan ? "Measured round trip, including network and proxy. GIS execution is timed separately." : "Example: 2,000 input tokens. TypeSafe reports 70–500 ms for Jev; your network and request size affect timing."}</p>
    <details class="cost-comparison" ${wasOpen ? "open" : ""}>
      <summary>Compare with Luna & Sonnet</summary>
      <table><caption>Illustrative cost per decision request</caption><thead><tr><th scope="col">Model</th><th scope="col">USD / call</th><th scope="col">Time</th></tr></thead><tbody>
        ${INFERENCE_RATES.map((rate, index) => `<tr><th scope="row"><a href="${rate.source}" target="_blank" rel="noopener noreferrer">${rate.name}</a></th><td>${index === 0 ? formatCost(cost) : formatCost(estimateInferenceCost(tokenBudget, 300, rate))}</td><td>${index === 0 ? latency : "Not measured"}</td></tr>`).join("")}
      </tbody></table>
      <p class="metric-note">${inputTokens === undefined ? "Jev did not report token usage; its cost is unavailable. LLM examples use 2,000 input tokens." : `${tokenBudget.toLocaleString()} input tokens${plan ? " reported by Jev" : " assumed"}.`} Luna and Sonnet estimates reuse that input count plus an assumed 300 output tokens for the decisions and probabilities. Different tokenizers, prompts, and reasoning can change the bill. Standard uncached rates; no tools or reasoning tokens included. Jev output is free.</p>
      <p class="metric-note">No Luna or Sonnet request was run here; their latency and decision quality on this map task are unbenchmarked.</p>
      <p class="metric-note"><a href="https://evals.typesafe.ai/" target="_blank" rel="noopener noreferrer">Published workflow context ↗</a>: TypeSafe reports mean times of 0.4 s for Jev, 12.9 s for “Luna,” and 78.1 s for Sonnet 5 across four larger workflows at default reasoning. These are vendor results, not predictions for this call; the overview does not specify Luna’s version.</p>
      <p class="metric-note">Pricing checked September 24, 2026. Model links above cite provider rates. <a href="https://typesafe.ai/blog/introducing-system-one-models-and-jev" target="_blank" rel="noopener noreferrer">Jev pricing and speed source ↗</a></p>
    </details>`;
}

function appendProbabilityGroup(
  parent: HTMLElement,
  title: string,
  values: Record<string, number>,
  labelFor: (key: string) => string,
): void {
  const group = document.createElement("div");
  group.className = "probability-group";
  const heading = document.createElement("h3");
  heading.textContent = title;
  group.append(heading);

  const rows = Object.entries(values).sort((left, right) => right[1] - left[1]);
  for (const [key, probability] of rows) {
    const row = document.createElement("div");
    row.className = "probability-row";
    const label = document.createElement("span");
    label.textContent = labelFor(key);
    const meter = document.createElement("progress");
    meter.max = 1;
    meter.value = probability;
    meter.setAttribute("aria-label", `${label.textContent}: ${Math.round(probability * 100)} percent`);
    const value = document.createElement("b");
    value.textContent = `${Math.round(probability * 100)}%`;
    row.append(label, meter, value);
    group.append(row);
  }
  parent.append(group);
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
