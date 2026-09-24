# Agent Working Agreement

## Project intent

JevMap is a typed spatial decision engine. Preserve the architectural boundary:

- the map provides structured state,
- candidate generators define legal choices,
- Jev makes narrow probabilistic decisions,
- ordinary code validates policy and parameters,
- the Spatial Workbench executes deterministic GIS operations,
- receipts record what happened.

Do not turn JevMap into an unrestricted GIS coding agent or generic chatbot.

## Engineering rules

1. Keep AI outputs bounded and typed. Prefer candidate generation plus Jev `choice`, `noul`, or `score` questions.
2. Never execute arbitrary model-generated JavaScript, SQL, or GIS code.
3. Validate every workbench call at runtime before execution.
4. Keep geometry operations deterministic and covered by tests.
5. Keep map-runtime dependencies behind adapter interfaces.
6. GeoJSON is the canonical MVP feature representation.
7. Preserve inspectable decision receipts for model-assisted actions.
8. Do not expose a production TypeSafe API key in browser code. Hosted deployments must proxy model calls server-side.
9. Add or update tests for behavioral changes.
10. Before merging, run `npm run typecheck`, `npm test`, and `npm run build`.

## Scope discipline

Prefer small vertical slices. The first complete path should be:

```text
GeoJSON -> normalized state -> legal candidates -> Jev choice -> policy -> validated Buffer -> result GeoJSON -> receipt
```

Add additional tools only after that loop is reliable.

## Source of truth

Read `docs/SPEC.md` before changing architecture or expanding scope.
