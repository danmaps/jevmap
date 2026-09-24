# Architecture

JevMap separates fuzzy judgment from deterministic spatial execution.

## Data flow

```text
User intent
  -> MapAdapter
  -> normalized JevMapState
  -> candidate generators
  -> TypeSafe / Jev decision
  -> confidence policy
  -> runtime workbench validation
  -> deterministic spatial operation
  -> result GeoJSON
  -> ActionReceipt
  -> updated map state
```

## Boundaries

### Map runtime

`src/map/` hides MapLibre-specific APIs behind a small adapter. Other renderers should be able to expose the same state without changing decision or workbench code.

### State

`src/state/` produces compact model context from GeoJSON and map state. Large datasets should be summarized deterministically before model calls.

### Jev

`src/jev/` owns the TypeSafe API contract and application confidence policy. Jev answers bounded questions. It does not execute GIS operations.

### Candidates

`src/candidates/` turns current state and tool constraints into legal choices. This is where open-ended GIS parameter spaces become finite model decisions.

### Workbench

`src/workbench/` validates calls and performs deterministic spatial computation. A model response cannot bypass this layer.

### Receipts

`src/receipts/` records state identity, model output, selected action, validation, and execution results so workflows can be inspected and replayed.

## First vertical slice

The first implementation milestone is deliberately narrow:

```text
load GeoJSON
  -> summarize layer
  -> create buffer/layer/distance candidates
  -> submit typed choice questions to Jev
  -> apply confidence policy
  -> validate BufferCall
  -> execute Turf buffer
  -> add result layer
  -> write receipt
  -> show probabilities + result on map
```

Once this loop is tested end to end, add `intersect`, `nearest`, filtering, selection, and workflow continuation one at a time.
