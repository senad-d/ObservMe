# Review validation

Use this checklist when closing the 2026-07-07 Pi extension review tasks. It records validation for the current checkout only; generated review specs are planning artifacts and do not by themselves mark the extension ready to ship.

## Current review task files

Execute the `*-2.md` review variants in order. Earlier files without the `-2` suffix are historical snapshots and should not be used as the active backlog.

1. `specs/spec-review-pi-extension-first-pass-tasks-2.md` — current first-pass review variant; completed.
2. `specs/spec-review-pi-extension-second-pass-tasks-2.md` — current second-pass review variant; completed.
3. `specs/spec-review-pi-extension-final-pass-tasks-2.md` — current final-pass review variant; continue from the first unchecked task.

## Final review validation commands

Run and record the current output from these commands instead of copying stale counts from earlier review snapshots:

```bash
npm run typecheck
npm run typecheck:test
npm run test
npm run lint:eslint
npm run format:check
npm run check:pack
npm audit --omit=dev --audit-level=moderate
```

Notes:

- `npm run typecheck` validates source TypeScript from `tsconfig.json`.
- `npm run typecheck:test` validates `test/**/*.ts` through `tsconfig.test.json` so TypeScript fixtures cannot drift from source APIs.
- `npm run test` prints the authoritative current test count for the checkout being reviewed.
- `npm run check:pack` validates package contents without publishing.
- `npm audit --omit=dev --audit-level=moderate` verifies production dependency exposure for the review; do not treat it as a publish approval.
