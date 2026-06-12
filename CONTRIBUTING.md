# Contributing To Athena

Athena is in a v4 rebuild. All implementation work should happen under `v4/` unless a change is explicitly about repository metadata.

## Ground Rules

- Read `v4/CLAUDE.md` before coding.
- Treat `v4/SEMANTICS.md` as the preserved-behavior contract.
- Add or update tests for every semantic change.
- Keep v4 TypeScript-first, strict, and pure ESM.
- Do not reintroduce the removed v3 runtime, launchers, or `.mjs` architecture.
- Do not ship `node_modules`; dependencies must be bundled or vendored according to the v4 plan.

## Verification

From `v4/`:

```bash
pnpm verify
```

CI runs the same v4 verification track on pull requests.

## Pull Request Checklist

- [ ] The change belongs to the v4 architecture.
- [ ] Preserved behavior changes update `v4/SEMANTICS.md`.
- [ ] Tests cover the changed behavior.
- [ ] `pnpm verify` passes from `v4/`.
- [ ] New dependencies are justified and compatible with bundled shipping.
