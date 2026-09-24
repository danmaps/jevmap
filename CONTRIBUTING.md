# Contributing

JevMap is early and architecture-sensitive. Read `docs/SPEC.md`, `docs/ARCHITECTURE.md`, and `AGENTS.md` before expanding scope.

## Local setup

```bash
npm install
npm run dev
```

Before opening or merging a change:

```bash
npm run typecheck
npm test
npm run build
```

## Pull requests

Keep changes small and vertical when possible. Include:

- what decision or spatial capability changed,
- how model outputs remain bounded,
- how runtime validation is enforced,
- tests for changed behavior,
- any impact on receipts or replayability.

New spatial tools should be added to the workbench registry with explicit input requirements and deterministic execution before they are exposed as Jev candidates.
