# Architecture

JevMap separates fuzzy judgment from deterministic spatial execution.

```text
User intent + authoritative map data
  -> semantic map summary
  -> eligible bounded DecisionFields / DecisionSurface
  -> selected provider (Jev-latest default, optional Julia)
  -> typed state diff and per-field policy dispositions
  -> deterministic guards and policy-controlled ranked fallback
  -> concrete approval when required
  -> fresh guards + validated deterministic Workbench
  -> result map state + canonical ActionReceipt
```

Meaning goes to the decision model; geometry stays in the spatial engine.

`src/map/` isolates MapLibre behind an adapter. `src/state/` summarizes runtime GeoJSON without sending samples or coordinates by default. `src/candidates/` derives legal options from authoritative application data and capabilities. `src/decisions/` builds bounded payloads and parses field changes with threshold, winner, ordered, and confirmation policies. `src/jev/` isolates provider contracts and response validation; Julia selection is explicit and requires review.

`src/analysis/workflow.ts` orchestrates the primary workflow. It captures complete runtime data hashes, records all bounded decisions, validates the model-selected operation, considers only declared fallback candidates, and rechecks freshness/feasibility before execution. `src/workbench/` owns deterministic Turf operations and runtime argument/geometry/capacity validation. `src/receipts/` stores replayable context, model provenance, decisions, guards, the actual call and execution outcome. `src/interpretation/` renders those same receipt records without another audit format.

See [DECISIONS.md](DECISIONS.md) for the field/diff contract, policies, guard/fallback behavior, receipt semantics and tests. See [JULIA.md](JULIA.md) for optional runtime setup and evaluation.
