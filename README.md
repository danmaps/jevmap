# JevMap

Typed AI decision logic for spatial applications.

JevMap connects an interactive GeoJSON-driven web map to [TypeSafe AI's Jev](https://typesafe.ai/) decision model. It serializes map state, generates bounded spatial action candidates, asks Jev to choose among those candidates, validates the result, and executes deterministic GIS operations through a Spatial Workbench-style tool layer.

The core loop is:

```text
map state -> candidate actions -> Jev decisions -> validated tool call -> spatial execution -> new map state
```

The project is inspired by [`danmaps/webmap_ai`](https://github.com/danmaps/webmap_ai), especially its provider-neutral map adapter, typed tool registry, runtime validation, and inspectable execution model. JevMap narrows the AI role further: Jev supplies judgment at fuzzy decision points while ordinary code owns geometry, validation, thresholds, and execution.

The design follows the [Spatial Workbench](https://workbench.dannymcvey.com/) pattern. In this demo, `src/workbench/index.ts` implements the validated tool layer locally: Turf.js computes buffers, and the MapLibre adapter displays the resulting GeoJSON. JevMap does not currently call the separate Spatial Workbench service or import its runtime.

## Goals

- Treat GeoJSON map state as structured model context.
- Keep the model inside a bounded, typed decision surface.
- Let Jev choose spatial tools, layers, and legal parameter candidates.
- Execute spatial operations deterministically with Turf.js and typed workbench tools.
- Re-evaluate after each operation using the updated map state.
- Record every model-assisted decision as an inspectable, replayable receipt.
- Keep the map runtime provider-neutral, starting with MapLibre GL JS.

## MVP

The first milestone targets:

- MapLibre GL JS map runtime
- GeoJSON source layers
- natural-language task input
- normalized map-state serialization
- TypeSafe `/v1/systemone` integration
- Jev `choice`, `noul`, and `score` questions
- bounded tool and parameter candidate generation
- Buffer, Intersect, Nearest, Filter, Select, and Export operations
- sequential multi-step execution
- confidence thresholds and review policy
- decision receipts and replayable workflows

## Architecture

```text
User goal
   |
   v
GeoJSON map state
   |
   v
Candidate generator
(tools + legal parameters)
   |
   v
Jev / TypeSafe System One
(choice / score / noul)
   |
   v
Policy + runtime validator
   |
   v
Spatial Workbench executor
   |
   v
Updated map state + receipt
   |
   +--------------------> next decision
```

## Repository layout

```text
src/
  map/          map adapter contracts and MapLibre integration
  state/        normalized state types and serialization
  jev/          TypeSafe API client and typed question helpers
  workbench/    spatial tool registry, validation, and execution
  candidates/   legal action and parameter candidate generation
  receipts/     inspectable decision and execution receipts
```

The full product and technical specification lives in [`docs/SPEC.md`](docs/SPEC.md).

## Development

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run typecheck
npm test
npm run build
```

To choose the model used by the server-side `/api/jev` proxy, configure:

```bash
VITE_TYPESAFE_MODEL=jev-latest
```

The browser sends bounded `choice` questions to `/api/jev`. The server-side proxy owns the TypeSafe credential. If the route is missing, the app displays an actionable proxy error. Never put a TypeSafe API key in a Vite environment variable or browser build.

The demo opens over Los Angeles with a muted dark OpenStreetMap basemap and eight synthetic sample points. The default task creates a 1-kilometer buffer around those points. The same preloaded dataset is available from **Download demo GeoJSON**, with its source in `public/demo/los-angeles-points.geojson`; these are illustrative points, not real facilities. Use **Add GeoJSON layers** to load additional FeatureCollections. The current vertical slice asks Jev to choose an operation, source layer, and legal buffer distance. High-confidence choices run automatically, medium-confidence choices wait for approval, and low-confidence choices produce a request for more context. Every decision and execution outcome is available in the receipt panel.

## Inference cost and speed

The floating panel measures each Jev request's browser-to-proxy round trip independently of Turf execution and retains reported token usage in the decision receipt. Estimated API cost uses published Jev pricing ($0.042 per million input tokens; output free). Missing usage displays as unavailable, not zero cost.

The comparison uses GPT-6 Luna ($0.10/$0.50 input/output per million tokens) and Claude Sonnet 5 ($2/$10), verified on September 24, 2026. It applies the same input-token budget and an illustrative 300-output-token budget to the LLMs; actual tokenizers, prompt overhead, and reasoning usage differ. The initial example uses 2,000 input tokens. Provider links appear in the panel. No Luna or Sonnet calls are executed, and no same-task latency or quality claim is made. A separate link summarizes TypeSafe's vendor-reported four-workflow timing context; those numbers do not predict this map call.

## Implementation status

The first vertical slice is a bounded GeoJSON-to-buffer workflow. Intersect, Nearest, Filter, Select, and workflow continuation remain future steps.
