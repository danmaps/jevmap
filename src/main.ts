import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import * as maplibregl from "maplibre-gl";
import {
  createBufferDecisionPlan,
  createPendingDecisionReceipt,
  executeBufferDecision,
  hashDecisionInputs,
  type BufferDecisionPlan,
  type SpatialData,
} from "./analysis/index.js";
import { JevProxyClient } from "./jev/proxy-client.js";
import { MapLibreAdapter } from "./map/index.js";
import { toReceiptSummary, type ActionReceipt } from "./receipts/index.js";
import { parseFeatureCollection } from "./state/geojson.js";
import { summarizeFeatureCollection, type JevMapState, type LayerState } from "./state/index.js";

const roads: SpatialData = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Main Street", class: "major road" },
      geometry: { type: "LineString", coordinates: [[-0.145, 51.515], [-0.115, 51.515], [-0.085, 51.515]] },
    },
    {
      type: "Feature",
      properties: { name: "North Road", class: "major road" },
      geometry: { type: "LineString", coordinates: [[-0.115, 51.495], [-0.115, 51.535]] },
    },
  ],
};

const schools: SpatialData = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { name: "Millbank Primary" }, geometry: { type: "Point", coordinates: [-0.125, 51.518] } },
    { type: "Feature", properties: { name: "Riverside Academy" }, geometry: { type: "Point", coordinates: [-0.102, 51.528] } },
    { type: "Feature", properties: { name: "Oakfield School" }, geometry: { type: "Point", coordinates: [-0.078, 51.498] } },
  ],
};

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
    <a class="brand" href="/jevmap/">DANNY MCVEY <span>/ JEVMAP</span></a>
    <span class="status"><i></i><span id="mode-label">JEV SERVER PROXY</span></span>
  </header>
  <main class="shell">
    <section class="intro">
      <p class="eyebrow">SPATIAL DECISION ENGINE · 01</p>
      <h1>Ask the map.<br /><em>Keep control.</em></h1>
      <p class="lede">Jev chooses from bounded spatial actions. Your application owns the geometry, validation, and execution.</p>
    </section>
    <section class="workspace">
      <div class="map-wrap"><div id="map" aria-label="JevMap demo map"></div><div class="map-label">LIVE MAP STATE</div></div>
      <aside class="panel">
        <div class="panel-kicker">WORKBENCH / TASK</div>
        <h2>What should we find?</h2>
        <label class="sr-only" for="goal">Spatial goal</label>
        <textarea id="goal">Create a 250 meter buffer around the major roads.</textarea>
        <label class="upload" for="geojson-files">Add GeoJSON layers<input id="geojson-files" type="file" accept=".json,.geojson,application/json,application/geo+json" multiple /></label>
        <div id="file-status" class="file-status" aria-live="polite">Sample layers are ready.</div>
        <button id="run" type="button">Ask Jev <span>↗</span></button>
        <div id="result" class="result" aria-live="polite" aria-busy="false">
          <div class="result-empty">Choose a spatial goal and ask for a buffer.<br /><span>Every operation is validated before it runs.</span></div>
        </div>
        <section class="layers"><div class="panel-kicker">MAP STATE</div><div id="layer-list"></div></section>
        <section id="receipt-section" class="receipts" hidden><div class="panel-kicker">DECISION RECEIPTS</div><div id="receipt-list"></div></section>
      </aside>
    </section>
    <section class="loop"><span>MAP STATE</span><b>→</b><span>CANDIDATES</span><b>→</b><span>JEV DECISION</span><b>→</b><span>VALIDATED EXECUTION</span></section>
    <p class="footnote">Live Jev requests use the server-side /api/jev proxy. The TypeSafe key stays out of the browser.</p>
  </main>`;

const goalInput = requiredElement<HTMLTextAreaElement>("#goal");
const runButton = requiredElement<HTMLButtonElement>("#run");
const fileInput = requiredElement<HTMLInputElement>("#geojson-files");
const resultElement = requiredElement<HTMLDivElement>("#result");
const fileStatus = requiredElement<HTMLDivElement>("#file-status");
const layerList = requiredElement<HTMLDivElement>("#layer-list");
const receiptSection = requiredElement<HTMLElement>("#receipt-section");
const receiptList = requiredElement<HTMLDivElement>("#receipt-list");
const modeLabel = requiredElement<HTMLSpanElement>("#mode-label");

const map = new maplibregl.Map({
  container: "map",
  center: [-0.11, 51.515],
  zoom: 13.2,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  },
});
const mapAdapter = new MapLibreAdapter(map);
const mapReady = new Promise<void>((resolve) => {
  map.once("load", () => {
    registerLayer("major-roads", "major-roads", roads);
    registerLayer("schools", "schools", schools);
    renderLayers();
    resolve();
  });
});

const jevClient = new JevProxyClient({ model: import.meta.env.VITE_TYPESAFE_MODEL || "jev-latest" });
modeLabel.textContent = "JEV SERVER PROXY";

runButton.addEventListener("click", () => void runAnalysis());
fileInput.addEventListener("change", () => void loadFiles());

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
