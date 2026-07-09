# Review validation

Use this checklist when closing the 2026-07-08 Pi extension review tasks. It records validation for the current checkout only; generated review specs are planning artifacts and do not by themselves mark the extension ready to ship or complete any review task.

## Current review task files

Execute the active review specs in order. The current checkout contains no active `*-2.md` review variants; treat any restored `*-2.md` files as historical snapshots unless a later review explicitly designates them as the active backlog.

1. `specs/spec-review-pi-extension-first-pass-tasks.md` — active first-pass review backlog; completed.
2. `specs/spec-review-pi-extension-second-pass-tasks.md` — active second-pass review backlog; completed.
3. `specs/spec-review-pi-extension-final-pass-tasks.md` — active final-pass review backlog; continue from the first unchecked task until the file is complete.

## Final review validation commands

Run and record the current output from these commands instead of copying stale counts from earlier review snapshots:

```bash
npm run typecheck
npm run typecheck:test
npm run lint:eslint
npm run format:check
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
npm run test
npm run check:pack
npm run check
npm run smoke:pi-runtime
```

Notes:

- `npm run typecheck` validates source TypeScript from `tsconfig.json`.
- `npm run typecheck:test` validates `test/**/*.ts` through `tsconfig.test.json` so TypeScript fixtures cannot drift from source APIs.
- `npm run lint:eslint` and `npm run format:check` validate repository linting and formatting without changing files.
- `npm audit --audit-level=moderate` verifies the full dependency tree for moderate-or-higher vulnerabilities.
- `npm audit --omit=dev --audit-level=moderate` verifies production dependency exposure for the review; do not treat it as a publish approval.
- `npm run test` prints the authoritative current test count for the checkout being reviewed.
- `npm run check:pack` validates package contents without publishing.
- `npm run check` validates script syntax for the package-content, coverage, smoke, and Grafana validation helpers.
- `npm run smoke:pi-runtime` runs a credential-free Pi RPC lifecycle smoke that covers extension reload through a smoke command that calls `ctx.reload()` (the same flow as `/reload`), RPC `new_session` replacement, and post-replacement `/obs status` and `/obs session` routing.
- `npm run validate` remains the broader release-oriented validation entry point, but the review checklist records explicit commands so failures can be attributed to source, test, lint, package, smoke, or audit stages.
