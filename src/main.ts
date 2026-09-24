import { Map, NavigationControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { MapLibreAdapter } from "./map/index.js";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app element.");

app.innerHTML = `
  <main class="layout">
    <section class="map-shell" aria-label="Map">
      <div id="map"></div>
      <div class="brand">JevMap</div>
    </section>
    <aside class="panel">
      <header>
        <p class="eyebrow">SPATIAL DECISION WORKBENCH</p>
        <h1>Typed decisions over map state.</h1>
        <p class="lede">GeoJSON becomes context. Jev chooses bounded actions. Deterministic tools do the GIS.</p>
      </header>

      <label for="goal">Goal</label>
      <textarea id="goal" rows="4" placeholder="Find buildings near streams."></textarea>
      <button id="inspect" type="button">Inspect map state</button>

      <section class="status" aria-live="polite">
        <p class="status-label">Current state</p>
        <pre id="state-output">Move the map or inspect the current viewport.</pre>
      </section>

      <footer>
        <span>v0.1 scaffold</span>
        <a href="https://github.com/danmaps/jevmap">GitHub</a>
      </footer>
    </aside>
  </main>
`;

const map = new Map({
  container: "map",
  style: "https://demotiles.maplibre.org/style.json",
  center: [-117.18, 34.055],
  zoom: 10,
});

map.addControl(new NavigationControl(), "top-right");
const adapter = new MapLibreAdapter(map);

const inspectButton = document.querySelector<HTMLButtonElement>("#inspect");
const stateOutput = document.querySelector<HTMLElement>("#state-output");

inspectButton?.addEventListener("click", () => {
  if (!stateOutput) return;
  stateOutput.textContent = JSON.stringify(adapter.getViewport(), null, 2);
});
