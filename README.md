# JevMap

Typed AI decision logic for spatial applications.

JevMap connects an interactive GeoJSON-driven web map to [TypeSafe AI's Jev](https://typesafe.ai/) decision model. It serializes map state, generates bounded spatial action candidates, asks Jev to choose among those candidates, validates the result, and executes deterministic GIS operations through a Spatial Workbench-style tool layer.

The core loop is:

```text
map state -> candidate actions -> Jev decisions -> validated tool call -> spatial execution -> new map state
```

The project is inspired by [`danmaps/webmap_ai`](https://github.com/danmaps/webmap_ai), especially its provider-neutral map adapter, typed tool registry, runtime validation, and inspectable execution model. JevMap narrows the AI role further: Jev supplies judgment at fuzzy decision points while ordinary code owns geometry, validation, thresholds, and execution.

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

To call TypeSafe from a local development environment, configure:

```bash
VITE_TYPESAFE_API_KEY=...
VITE_TYPESAFE_MODEL=jev-latest
```

The current scaffold does not make an API request on page load. The API client is isolated so secrets can later be moved behind a server-side boundary before any hosted deployment.

## Status

Early scaffold. The immediate goal is to prove one end-to-end loop: load GeoJSON, serialize state, generate legal tool candidates, ask Jev for a typed choice, execute one deterministic operation, and emit a receipt.
