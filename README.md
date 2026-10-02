# JevMap

Typed AI decision logic for spatial applications.

JevMap connects an interactive GeoJSON-driven web map to [TypeSafe AI's Jev](https://typesafe.ai/) decision model. It summarizes map state semantically, generates bounded decision fields, obtains a typed state diff, applies field-specific policy and runtime guards, and executes deterministic GIS operations through a Spatial Workbench-style tool layer. Jev remains the default; Julia 1 is an explicit optional local backend.

The core loop is:

```text
deterministic application -> bounded decision surface -> typed state diff -> deterministic execution
```

The project is inspired by [`danmaps/webmap_ai`](https://github.com/danmaps/webmap_ai), especially its provider-neutral map adapter, typed tool registry, runtime validation, and inspectable execution model. JevMap narrows the AI role further: Jev supplies judgment at fuzzy decision points while ordinary code owns geometry, validation, thresholds, and execution.

The design follows the [Spatial Workbench](https://workbench.dannymcvey.com/) pattern. In this demo, `src/workbench/index.ts` implements the validated tool layer locally: Turf.js computes buffers, and the MapLibre adapter displays the resulting GeoJSON. JevMap does not currently call the separate Spatial Workbench service or import its runtime.

## Goals

- Send compact semantic map summaries to the decision model; keep geometry in the spatial engine.
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
- field-specific decision policies, review, and guarded ranked fallback
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

The original product specification lives in [`docs/SPEC.md`](docs/SPEC.md). The current decision architecture, policies, guards, and receipt contract are documented in [`docs/DECISIONS.md`](docs/DECISIONS.md).

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

The demo opens over Los Angeles with eight synthetic sample points. Use **Add GeoJSON layers** or a tool example to load FeatureCollections. **Interpret task** asks the selected provider for bounded operation/layer/parameter choices. All six tools pass application policy and deterministic guards before execution. Review decisions and permitted lower-ranked fallbacks display the exact proposed call and require approval. Stale map data blocks execution. The live panel shows each model choice, probability, policy disposition, and execution outcome, with full distributions and canonical receipts available on demand.

Select **Demo · simulated** to exercise the complete local workflow offline. Select **Julia 1 · local CPU** after following [`docs/JULIA.md`](docs/JULIA.md). That backend uses the real released checkpoint through an optional loopback Python service and includes a reproducible fixture evaluation. Jev stays the default hosted path. Neither local mode requires a model API key in the browser.

## Inference cost and speed

The floating panel measures each Jev request's browser-to-proxy round trip independently of Turf execution and retains reported token usage in the decision receipt. Estimated API cost uses published Jev pricing ($0.042 per million input tokens; output free). Missing usage displays as unavailable, not zero cost.

The comparison uses GPT-6 Luna ($0.10/$0.50 input/output per million tokens) and Claude Sonnet 5 ($2/$10), verified on September 24, 2026. It applies the same input-token budget and an illustrative 300-output-token budget to the LLMs; actual tokenizers, prompt overhead, and reasoning usage differ. The initial example uses 2,000 input tokens. Provider links appear in the panel. No Luna or Sonnet calls are executed, and no same-task latency or quality claim is made. A separate link summarizes TypeSafe's vendor-reported four-workflow timing context; those numbers do not predict this map call.

## Implementation status

Buffer, Intersect (feature selection against a polygon overlay), Nearest (Point-to-Point connections), scalar Filter, bounded Select, and GeoJSON Export execute through the local validated Workbench. The primary workflow uses generic decision surfaces, semantic context, per-field policies, full-data stale checks, and auditable fallback. Julia is optional and experimentally evaluated; the report records overconfident mistakes and unmeasured Jev comparisons without changing the default.
