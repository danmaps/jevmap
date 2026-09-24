import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { actionCriteria, distanceCriteria, generateActionCandidates, DEFAULT_DISTANCE_CANDIDATES } from './candidates/index.js';
import { summarizeFeatureCollection } from './state/index.js';
import { executeWorkbenchCall } from './workbench/index.js';

const roads: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Main Street', class: 'major road' }, geometry: { type: 'LineString', coordinates: [[-0.145, 51.515], [-0.115, 51.515], [-0.085, 51.515]] } },
    { type: 'Feature', properties: { name: 'North Road', class: 'major road' }, geometry: { type: 'LineString', coordinates: [[-0.115, 51.495], [-0.115, 51.535]] } },
  ],
};

const schools: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Millbank Primary' }, geometry: { type: 'Point', coordinates: [-0.125, 51.518] } },
    { type: 'Feature', properties: { name: 'Riverside Academy' }, geometry: { type: 'Point', coordinates: [-0.102, 51.528] } },
    { type: 'Feature', properties: { name: 'Oakfield School' }, geometry: { type: 'Point', coordinates: [-0.078, 51.498] } },
  ],
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root not found');

app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="/">DANNY MCVEY <span>/ JEVMAP</span></a>
    <span class="status"><i></i> DEMO MODE</span>
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
        <textarea id="goal">Find schools that are close to major roads.</textarea>
        <button id="run" type="button">Ask Jev <span>↗</span></button>
        <div id="result" class="result" aria-live="polite">
          <div class="result-empty">A bounded decision will appear here.<br /><span>Nothing executes without a validated tool call.</span></div>
        </div>
        <div class="layers"><div class="panel-kicker">MAP STATE</div><div class="layer"><b><i class="dot road"></i> major-roads</b><span>2 features</span></div><div class="layer"><b><i class="dot school"></i> schools</b><span>3 features</span></div></div>
      </aside>
    </section>
    <section class="loop"><span>MAP STATE</span><b>→</b><span>CANDIDATES</span><b>→</b><span>JEV DECISION</span><b>→</b><span>VALIDATED EXECUTION</span></section>
    <p class="footnote">This hosted preview uses a deterministic demo decision. TypeSafe API access will be routed server-side before production use.</p>
  </main>`;

const map = new maplibregl.Map({
  container: 'map',
  center: [-0.11, 51.515],
  zoom: 13.2,
  attributionControl: false,
  style: {
    version: 8,
    sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' } },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  },
});

map.on('load', () => {
  map.addSource('roads', { type: 'geojson', data: roads });
  map.addLayer({ id: 'roads', type: 'line', source: 'roads', paint: { 'line-color': '#e1a84b', 'line-width': 4, 'line-opacity': 0.9 } });
  map.addSource('schools', { type: 'geojson', data: schools });
  map.addLayer({ id: 'schools', type: 'circle', source: 'schools', paint: { 'circle-color': '#f16b5b', 'circle-radius': 7, 'circle-stroke-color': '#fff4df', 'circle-stroke-width': 2 } });
});

document.querySelector<HTMLButtonElement>('#run')?.addEventListener('click', async () => {
  const result = document.querySelector<HTMLDivElement>('#result');
  if (!result) return;
  const button = document.querySelector<HTMLButtonElement>('#run');
  if (button) button.disabled = true;
  result.innerHTML = '<div class="result-empty">Asking Jev to choose from the live workbench registry…</div>';
  try {
    const layers = new Map([
      ['roads', roads],
      ['schools', schools],
    ]);
    const state = {
      intent: (document.querySelector<HTMLTextAreaElement>('#goal')?.value ?? '').trim(),
      viewport: { bbox: [-0.16, 51.49, -0.07, 51.54] as [number, number, number, number], zoom: map.getZoom() },
      layers: [summarizeFeatureCollection('roads', 'Major roads', roads), summarizeFeatureCollection('schools', 'Schools', schools)],
      selection: { featureIds: [] },
      previousActions: [],
    };
    const candidates = generateActionCandidates(state).filter((candidate) => ['buffer', 'export'].includes(candidate.id));
    const response = await fetch('/api/jev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state,
        model: 'jev-latest',
        questions: {
          action: { type: 'choice', instructions: 'Choose the implemented spatial operation that best advances the stated goal. Prefer buffer for proximity questions.', criteria: actionCriteria(candidates) },
          distance: { type: 'choice', instructions: 'Choose a reasonable legal distance for the stated proximity goal.', criteria: distanceCriteria(DEFAULT_DISTANCE_CANDIDATES) },
        },
      }),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error('The live Jev proxy is not connected yet. Add the /api/jev Caddy route and start jevmap.service.');
    }
    const payload = await response.json() as { answers?: { action?: { choice?: string; confidence?: number }; distance?: { choice?: string } }; error?: string };
    if (!response.ok || !payload.answers?.action?.choice) throw new Error(payload.error ?? `Jev request failed (${response.status})`);
    const action = payload.answers.action.choice;
    const confidence = payload.answers.action.confidence ?? 0;
    const distanceId = payload.answers.distance?.choice ?? '250m';
    const distance = DEFAULT_DISTANCE_CANDIDATES.find((candidate) => candidate.id === distanceId)?.meters ?? 250;
    if (action !== 'buffer') throw new Error(`Jev selected ${action}, which is not yet executable in this demo.`);
    const execution = await executeWorkbenchCall({ tool: 'buffer', args: { layerId: 'roads', distanceMeters: distance } }, { layers });
    const source = map.getSource('result') as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(execution.data as FeatureCollection);
    else {
      map.addSource('result', { type: 'geojson', data: execution.data });
      map.addLayer({ id: 'result', type: 'fill', source: 'result', paint: { 'fill-color': '#d49b4a', 'fill-opacity': 0.18, 'fill-outline-color': '#d49b4a' } }, 'schools');
    }
    result.innerHTML = `<div class="decision"><div class="decision-head"><span class="check">✓</span><div><small>JEV SELECTED</small><strong>${action}</strong></div><b>${confidence.toFixed(2)}</b></div><p>Jev selected a legal ${distance}m candidate for the proximity goal.</p><div class="call"><small>VALIDATED + EXECUTED WORKBENCH CALL</small><code>buffer(major-roads, ${distance}m)</code></div><div class="receipt">TypeSafe Jev · ${execution.data.features.length} source features · Turf.js result</div></div>`;
    map.flyTo({ center: [-0.115, 51.515], zoom: 13.7, duration: 900 });
  } catch (error) {
    result.innerHTML = `<div class="error"><strong>Jev could not run.</strong><br /><span>${error instanceof Error ? error.message : 'The server proxy is unavailable.'}</span></div>`;
  } finally {
    if (button) button.disabled = false;
  }
});
