# JevMap v0.1 Product and Technical Specification

## Summary

JevMap is a lightweight spatial decision engine that connects an interactive web map to TypeSafe AI's Jev model.

The application converts the current map into a compact, GeoJSON-driven state representation. Jev evaluates that state against a bounded catalog of spatial tools and legal parameter candidates. Its typed decisions are converted into validated Spatial Workbench tool calls, executed deterministically, and reflected back onto the map.

The core loop is:

```text
map state -> candidate actions -> Jev decisions -> validated tool call -> spatial execution -> new map state
```

JevMap builds on the architectural ideas in `webmap_ai`: provider-neutral map adapters, a central typed tool registry, runtime validation, and a bounded executor.

## Product idea

A user opens a map containing one or more GeoJSON datasets and asks for an outcome such as:

> Find the schools that are close to major roads.

JevMap does not ask Jev to generate GIS code. The application supplies Jev with structured state and bounded decisions:

- the user's goal
- current viewport and selection
- layer metadata
- GeoJSON feature state or deterministic summaries
- available spatial tools
- valid input layers
- valid parameter candidates
- previous tool results

Jev then answers narrow questions such as:

- Which spatial tool best advances the task?
- Which layer should be the input?
- Which second layer should participate?
- Which candidate distance is appropriate?
- Is the proposed operation relevant enough to execute?
- Does the current result satisfy the user's goal?

Application code owns the workflow, geometry, validation, thresholds, and side effects.

## Design principles

### 1. Map state is data

The visible application state is serialized into a normalized object rather than represented through screenshots.

GeoJSON is the canonical feature representation for the MVP.

```ts
export interface JevMapState {
  intent: string;
  viewport: {
    bbox: [number, number, number, number];
    zoom: number;
    bearing?: number;
    pitch?: number;
  };
  layers: LayerState[];
  selection: {
    layerId?: string;
    featureIds: string[];
  };
  previousActions: ActionReceipt[];
}
```

A layer should contain enough information for spatial judgment without requiring every coordinate and attribute in a large dataset.

```ts
export interface LayerState {
  id: string;
  name: string;
  geometryType: string;
  featureCount: number;
  fields: FieldSummary[];
  extent?: [number, number, number, number];
  sample?: GeoJSON.FeatureCollection;
  summary?: SpatialSummary;
}
```

Large datasets should be reduced before they are sent to Jev through deterministic summaries, samples, extents, counts, categorical statistics, and other map-derived metadata.

### 2. The tool registry defines what Jev can decide

JevMap maintains a Spatial Workbench registry similar to the registry in `webmap_ai`.

Initial analysis tools:

```text
Buffer
Intersect
Nearest
Filter
Select
Export
```

Likely follow-ons:

```text
SpatialJoin
Dissolve
Clip
Union
AggregatePoints
GenerateRandomPoints
ConvexHull
Centroid
Route
RasterSample
```

Each tool declares its requirements and deterministic executor.

```ts
export interface SpatialToolDefinition<TArgs = unknown, TResult = unknown> {
  id: string;
  description: string;
  inputRequirements: InputRequirement[];
  parameterDefinitions: ParameterDefinition[];
  mutatesState: boolean;
  execute(args: TArgs): Promise<TResult>;
}
```

### 3. Jev chooses bounded actions

Jev's `choice` primitive is the primary routing mechanism.

For example, the application may offer:

```text
buffer
nearest
intersect
filter
select
export
```

with the instruction:

```text
Which available spatial operation best advances the user's stated goal?
```

TypeSafe's `/v1/systemone` endpoint returns the selected choice, confidence, and the probability distribution over the supplied criteria. Application policy can then decide whether to execute, preview, or request more context.

Example policy:

```ts
if (confidence >= 0.8) {
  execute();
} else if (confidence >= 0.55) {
  previewForUser();
} else {
  requestMoreContext();
}
```

Thresholds are application policy, not model behavior.

### 4. Parameter values come from candidate generation

Jev should generally select parameter values from legal candidates rather than inventing arbitrary values.

For a Buffer tool, a candidate generator might expose:

```ts
const distanceCandidates = [
  { id: "25m", meters: 25 },
  { id: "50m", meters: 50 },
  { id: "100m", meters: 100 },
  { id: "250m", meters: 250 },
  { id: "500m", meters: 500 },
  { id: "1km", meters: 1000 },
];
```

Layer parameters are generated directly from map state. Field parameters come from layer schemas. Spatial predicates come from fixed enums.

The resulting decision is converted into a fully typed workbench call:

```json
{
  "tool": "buffer",
  "args": {
    "layerId": "schools",
    "distance": 250,
    "units": "meters"
  }
}
```

The workbench still validates the call before execution.

### 5. Free-form parameters require a separate resolver

Some GIS parameters cannot reasonably be represented as a short candidate list, including:

- arbitrary attribute expressions
- calculated formulas
- exact coordinates
- complex field mappings
- novel numeric thresholds
- output names

JevMap resolves these through one of three mechanisms:

1. **Deterministic derivation**: calculate the value from map state.
2. **Candidate generation**: generate a finite set of reasonable values and let Jev choose.
3. **Optional generative planner**: use a conventional LLM to propose typed candidate actions, then validate and optionally judge those actions with Jev before execution.

The MVP should attempt to operate without a generative planner first.

## TypeSafe API boundary

As of this specification, TypeSafe exposes `POST /v1/systemone` with a request containing:

```ts
interface SystemOneRequest {
  state: string | Record<string, unknown> | unknown[];
  model: string;
  questions: Record<string, Question>;
}
```

The three supported question types are:

- `choice`: select one supplied criterion and return confidence plus probabilities
- `noul`: return a probability for a yes/true judgment
- `score`: rate state against ordered criteria and return an expected score, confidence, and probabilities

JevMap should isolate this contract in `src/jev/` so model/API changes do not leak into map or workbench code.

## Execution loop

Each analysis step follows the same lifecycle:

```text
+---------------------+
| User goal           |
+----------+----------+
           |
           v
+---------------------+
| GeoJSON map state   |
+----------+----------+
           |
           v
+---------------------+
| Candidate generator |
| tools + parameters  |
+----------+----------+
           |
           v
+---------------------+
| Jev                 |
| choice/score/noul   |
+----------+----------+
           |
           v
+---------------------+
| Policy + validator  |
+----------+----------+
           |
           v
+---------------------+
| Spatial Workbench   |
| executes operation  |
+----------+----------+
           |
           v
+---------------------+
| Updated map state   |
+----------+----------+
           |
           +------------------> next decision
```

A multi-step spatial workflow uses multiple Jev decisions against progressively updated state. Each decision can incorporate the actual output of the preceding operation.

## Example workflow

User goal:

> Show me parks near schools.

Loaded layers:

```text
schools.geojson
parks.geojson
roads.geojson
```

### Decision 1: operation

Candidates:

```text
buffer
nearest
intersect
filter
```

A possible Jev response:

```text
buffer      0.71
nearest     0.21
intersect   0.07
filter      0.01
```

### Decision 2: input layer

```text
schools     0.96
parks       0.03
roads       0.01
```

### Decision 3: distance

```text
100m        0.10
250m        0.38
500m        0.43
1km         0.09
```

The application policy resolves the choice and executes:

```text
Buffer(schools, 500m)
```

The resulting GeoJSON becomes part of map state.

### Decision 4

The next candidate generation pass may expose `intersect` between the buffered schools and parks. If selected and validated, the workbench executes it and the result appears on the map.

## Decision receipts

Every AI-assisted action should produce an inspectable receipt.

```ts
export interface ActionReceipt {
  id: string;
  timestamp: string;
  stateHash: string;
  model: string;
  question: string;
  probabilities: Record<string, number>;
  confidence: number;
  selectedAction: string;
  args: unknown;
  validation: {
    valid: boolean;
    warnings: string[];
  };
  execution: {
    success: boolean;
    durationMs: number;
    error?: string;
  };
}
```

Receipts make the system inspectable, replayable, debuggable, benchmarkable, and testable. They also create a dataset for evaluating Jev's spatial decisions over time.

## UI

The MVP should remain deliberately simple.

### Main map

MapLibre GL JS first. The map displays source layers, intermediate results, selections, and final results.

### Task input

A single natural-language goal field, for example:

```text
Find buildings near streams.
```

### Decision panel

Show the current bounded decision and probability distribution:

```text
Next operation

Buffer            78%
Nearest           14%
Intersect          6%
Filter             2%
```

and parameter decisions:

```text
Buffer distance

100 m               8%
250 m              31%
500 m              52%
1 km                 9%
```

### Workflow history

```text
1. Buffer streams 500 m
2. Intersect buildings
3. Select 17 features
```

Each row can expand into its receipt.

## MVP scope

The first usable JevMap should support:

- MapLibre GL JS
- GeoJSON layers
- natural-language task input
- map-state serialization
- TypeSafe API integration
- typed tool selection
- typed layer selection
- candidate-based parameter selection
- Buffer
- Intersect
- Nearest
- Filter
- Select
- Export GeoJSON
- sequential multi-step execution
- probability display
- confidence thresholds
- execution receipts
- replayable workflows

No ArcGIS dependency is required. Turf.js provides the initial deterministic geometry engine.

## Suggested repository structure

```text
jevmap/
  docs/
    SPEC.md
  src/
    map/
      adapter.ts
      maplibre.ts
    state/
      types.ts
      serialize.ts
    jev/
      types.ts
      client.ts
      questions.ts
      policy.ts
    workbench/
      types.ts
      registry.ts
      router.ts
      tools/
    candidates/
      actions.ts
      parameters.ts
    receipts/
      types.ts
      receipts.ts
    main.ts
  tests/
  .github/workflows/
```

## Security boundary

The browser scaffold may use `VITE_TYPESAFE_API_KEY` for local-only experimentation, but a hosted build must not expose a long-lived API key to the browser. Before deployment, Jev requests should move behind a small server/serverless endpoint that accepts normalized state and bounded questions, then forwards them to TypeSafe.

The server-side boundary should enforce:

- authenticated or rate-limited access as appropriate
- maximum state size
- allowed model aliases
- allowed Jev question types
- bounded criteria counts
- request logging without sensitive feature payloads by default

## Non-goals for v0.1

- arbitrary generated GIS code
- direct database mutation
- autonomous editing of production GIS data
- raster processing
- ArcGIS-specific dependencies
- unrestricted SQL generation
- model-driven browser/UI control

## Success criteria

A successful MVP can accept three arbitrary GeoJSON layers and a spatial task such as:

> Find residential parcels within walking distance of parks.

Without generating executable GIS code, the system should:

1. inspect the map state,
2. identify relevant layers,
3. choose appropriate spatial operations,
4. choose valid parameter candidates,
5. execute those operations,
6. update state after each operation,
7. stop when the requested result has been produced,
8. display the output on the map,
9. provide a complete receipt of every AI-assisted decision.

All spatial execution remains deterministic and reproducible.

Jev provides judgment at fuzzy decision points. The Spatial Workbench provides computation. The map provides state. That separation is the core of JevMap.
