# Roadmap

## Milestone 1: first complete decision loop

- Load one or more GeoJSON layers into the demo.
- Normalize map/layer state.
- Generate legal action, layer, and distance candidates.
- Submit typed `choice` questions to Jev.
- Apply the confidence policy.
- Validate and execute a Turf buffer.
- Add the result GeoJSON to the map.
- Emit and display an `ActionReceipt`.
- Cover the full loop with tests.

## Milestone 2: pairwise spatial analysis

- Implement `intersect`.
- Implement `nearest`.
- Add candidate rules based on geometry compatibility.
- Add multi-layer result provenance to receipts.

## Milestone 3: attribute workflows

- Add deterministic filtering.
- Add field/schema summaries to model state.
- Add selection and result inspection.
- Keep arbitrary SQL generation out of the model boundary.

## Milestone 4: multi-step orchestration

- Feed result layers back into normalized state.
- Ask Jev whether the current result satisfies the user goal.
- Continue through bounded steps until completion or review is required.
- Add replay from stored receipts.

## Milestone 5: deployment boundary

- Move TypeSafe calls behind a server/serverless endpoint.
- Add request-size and candidate-count limits.
- Add rate limiting and environment-based model selection.
- Add hosted demo deployment and browser-level tests.
