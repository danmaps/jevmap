# Bounded decisions and deterministic execution

The application follows this pattern:

```text
deterministic application -> bounded decision surface -> typed state diff -> deterministic execution
```

Meaning goes to the decision model; geometry stays in the spatial engine.

## Fields and surfaces

`src/decisions/index.ts` defines a generic `DecisionField<T>` with a semantic label, question, current value, fixed option IDs/descriptions/values, an optional keep path, and a policy. A `DecisionSurface<TValues>` groups fields independently of its semantic map context. The payload builder exposes only supplied options; the parser rejects missing, unknown, incomplete, nonfinite, or unnormalized distributions.

`__keep__` resolves to the field's exact current value. Selecting the same value also produces a keep disposition. The typed diff contains only applied changes; review, clarification, rejection, and unchanged values cannot enter it. Field records retain the model choice, complete probabilities, policy-selected value, policy evidence, and disposition. Ordered-policy substitutions remain distinct from the original model selection.

The primary workflow in `src/analysis/workflow.ts` asks for the operation, then its eligible input and relevant parameters. Buffer distance, pairwise overlay/target, scalar attribute predicates, feature sets, and export format come from finite candidates. It does not ask for irrelevant buffer parameters on other operations. Follow-up requests can keep eligible current values. Single-candidate Julia fields are resolved deterministically, since native Julia inference accepts 2–20 options.

## Policy

Policy evaluation is deterministic application code:

| Kind | Behavior | Example |
| --- | --- | --- |
| Threshold | Apply/review/clarify at declared boundaries | Compatibility policy |
| Winner | Consider both selected probability and confidence, require separation | Operation and input layer |
| Ordered | Use the supplied ordinal scale, weighted median and neighboring probability mass | Buffer distance |
| Confirmation | Require explicit review regardless of high probability | Future destructive/overwrite fields |

An ordered policy selects an existing option, never an interpolated distance. A confirmation policy never approves itself. The old threshold helper remains available for compatibility; it no longer controls the primary workflow.

Model probability is evidence returned by the model, not calibrated correctness. A high-probability result must still pass deterministic checks. Jev remains the default; the optional Julia runtime and its measured limitations are described in [JULIA.md](JULIA.md).

## Semantic context

`semanticMapState` emits normalized viewport/extent metadata, stable layer IDs and names, geometry types, feature counts, typed fields, bounded selection metadata, active result provenance, capabilities, and bounded history. Raw samples, FeatureCollections, feature properties, and coordinate arrays are excluded. Field current-value context can be summarized independently of the exact typed value, so a large selection does not expand the model payload.

The optional `geometrySummaries` escape hatch requires a layer ID, purpose, and finite primitive metrics. It does not admit geometry or ask the model to compute spatial relationships. Candidate eligibility is rebuilt from authoritative runtime feature data, and the Workbench revalidates the actual layers.

## Guards, fallback and approval

Every operation uses `validateWorkbenchCall` before execution. Guards cover current layer identity, supported geometry, required fields/feature IDs, legal parameters and format, browser feature/comparison/export limits. Intersect selects input features intersecting a polygon overlay; nearest connects Point features to their nearest Point target. They use Turf rather than example-specific approximations.

Plans capture a consistent snapshot before inference, including the decision input hash, **complete runtime feature data**, runtime limits, and declared capabilities. A map edit anywhere in the layer, including beyond the summary sample, invalidates the plan. Active-result changes also invalidate it. Panning alone does not invalidate approval. A synchronous snapshot comparison closes the asynchronous hashing and lazy Turf-import windows immediately before GIS runs. Capabilities restrict both input and pairwise target/overlay layers. The approval flow excludes its own pending receipt from history comparison.

The original operation is checked first. If infeasible, subsequent supplied operations are considered in descending probability order. Only candidates with application-defined parameter combinations and probability at least 0.1 are eligible. A fallback below 0.8 requires review; other field review requirements remain in force. Missing parameters are a rejection, not permission to invent them. No additional model call is made to improvise fallback. Stale state blocks the entire plan, including fallback.

Approval applies to the concrete call shown. A binding digest pins the original bounded fields, candidate calls, proposal policy, fallback thresholds, and runtime snapshots. Changed arguments or fields require a fresh decision even if the changed call would otherwise pass Workbench validation. Application overrides can make review stricter, but cannot relax canonical field clarification or review. Typed receipt diffs are rebuilt from the bound fields before execution. A newly substituted call cannot inherit approval for a different call. If no viable candidate passes, the receipt gives rejected candidate reasons and the UI requests compatible layers, smaller data, or a fresh request.

Every retained routing/parameter field gets an independent execution gate before a new spatial effect. Keep remains an unchanged field record with no diff; weak keep evidence cannot authorize execution. Reviewed approval receipts must match the original concrete plan. Rejected calls have an empty applied diff. Fallback diffs contain only values used by the executed call, including deterministic fallback parameters; unused model parameters remain inspectable and are labeled unused. Receipts are detached snapshots, so later plan mutation cannot rewrite history.

Julia is experimental and requires explicit concrete review even when all field policies say apply. This bound proposal policy cannot be relaxed by changing the mutable execution policy. It mitigates unintended automatic effects; it does not make an overconfident interpretation correct. The compatibility `executeBufferDecision` helper now requires the current `JevMapState` as its fifth argument and fails closed without it; new callers should use `executeSpatialDecision`.

## Canonical receipts and live UI

Every completed model response shares the same receipt shape across providers. It includes the semantic snapshot, exact bounded payloads and raw model responses, fields and typed diff, provider/runtime/version provenance, ranked operations, guard rejections, original/final candidate, concrete call, validation and execution outcome. Review approval updates the same receipt identity.

The live panel renders those canonical records, with selected option probability separate from policy disposition. Distributions expand on demand. Keep, rejected/malformed, reviewed, approved, ordered replacement and fallback states remain explicit. The exact proposed call appears before approval; the executed call and timing appear after success. The receipt link opens the existing detailed record.

## Verification

The normal quality gates are `npm run typecheck`, `npm test`, and `npm run build`. Tests cover generic payload/diff parsing and keep, policy boundaries and ambiguity, semantic points/lines/polygons/empty/multiple layers and context reduction, provider response mapping, guarded execution and fallbacks, stale complete data, all deterministic tools, and interpretation states. The optional real Julia evaluation is reproducible with the commands in [JULIA.md](JULIA.md); its report distinguishes actual inference from simulation and unmeasured Jev results.
