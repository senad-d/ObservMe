# First-pass Pi extension review tasks

Review scope and date: 2026-07-07. Security, runtime correctness, input validation, dependency, and high-risk Pi extension behavior review for the current ObservMe project state. Existing review specs were present, so this variant was created. No implementation changes were made.

## Files or areas reviewed

- Extension entrypoint and package metadata: `src/extension.ts`, `package.json`, `tsconfig.json`, `eslint.config.js`.
- Pi event handlers and stateful telemetry lifecycle: `src/pi/handlers.ts`, `src/pi/subagent-spawn.ts`, `src/pi/agent-lineage.ts`, `src/util/bounded-map.ts`.
- Config loading and validation boundaries: `src/config/load-config.ts`, `src/config/schema.ts`, `src/config/validate.ts`, `.env.example`, `.pi/observme.yaml` presence.
- Public command surface and high-risk backfill flow: `src/commands/obs.ts`, `src/commands/obs-backfill.ts`, `src/commands/obs-diagnostics.ts`.
- Grafana/query transport and secret-safe error handling: `src/query/grafana-transport.ts`, `src/query/grafana-readiness.ts`, `src/query/grafana.ts`, `src/query/loki.ts`, `src/query/prometheus.ts`, `src/query/tempo.ts`.
- Test coverage inventory under `test/` and existing `specs/spec-review-pi-extension-*-tasks.md` files.

## Safe commands run and results

- `npm run typecheck` — passed.
- `npm run test` — passed, 245 tests.
- `npm audit --omit=dev --audit-level=moderate` — passed, 0 vulnerabilities.
- `npm run lint:eslint && npm run format:check && npm run check:pack` — passed; package dry-run contained 55 files.
- Read-only searches for unsafe constructs, secrets, shell execution, path/file access, unresolved TODOs, TypeScript suppressions, and high-risk query/auth code were run with `find`/`rg`.

## Findings summary by severity

- Medium: Type checking excludes TypeScript tests, so `.ts` test fixtures can drift from source types and miss security or boundary-regression issues.
- Medium: Backfill export can run without an abort/cancellation path once confirmed, which can prolong historical replay/export in a Pi command context if an exporter stalls.
- Low: A real project-local `.env` file exists in the working tree; packaging excludes it, but secret-hygiene verification should be kept explicit because the extension intentionally reads trusted project `.env` files.

## Ordered tasks

- [x] Add TypeScript type checking for TypeScript tests and shared test fixtures

#### Why

`tsconfig.json` only includes `src/**/*.ts`, while the repository contains TypeScript tests such as `test/event-mapping.test.ts`, `test/metrics.test.ts`, `test/cardinality.test.ts`, and `test/redaction.test.ts`. `npm run typecheck` can pass even if those TypeScript tests no longer type-check against source APIs. That weakens the security and boundary tests that are meant to catch unsafe input handling, redaction, and telemetry-label regressions.

#### How to resolve

- Inspect `tsconfig.json`, Node test execution behavior for `.ts` tests, and all `test/**/*.ts` files.
- Add a non-emitting test type-check path, either by expanding the existing project configuration safely or by adding a dedicated `tsconfig.test.json` plus a package script.
- Ensure the configuration includes only intended source and test files, excludes generated/state directories, and does not weaken `strict` source checking.
- Add the new test type-check script to the validation path if it is fast enough; otherwise document when it must be run.
- Validate with `npm run typecheck`, the new test type-check command, `npm run test`, and `npm run lint:eslint`.

#### Acceptance criteria

- TypeScript test files under `test/**/*.ts` are checked by an explicit `tsc --noEmit` command.
- A deliberate type drift between a source export and a TypeScript test would fail validation.
- Existing source strictness is not relaxed and no TypeScript errors are silenced.
- The relevant type-check, test, and lint commands pass.

- [x] Add abort-aware bounded execution to confirmed backfill export

#### Why

`src/commands/obs-backfill.ts` asks for explicit confirmation and rate-limits records, but after confirmation the replay loop and exporter operations do not accept or propagate an abort signal. A slow or stuck exporter can keep a Pi command running longer than the user expects. Because backfill can replay historical content-derived telemetry, cancellation and bounded shutdown are part of safe operational behavior.

#### How to resolve

- Review `handleObsBackfillCommand`, `runObsBackfill`, `confirmObsBackfill`, `exportObsBackfillRecords`, `ObsBackfillExporter`, and `createObsBackfillLogExporter` in `src/commands/obs-backfill.ts`.
- Decide how command cancellation should be represented from Pi context, for example an optional `AbortSignal` on the command context or exporter methods.
- Thread the signal through confirmation, `waitForIdle`, record building, exporter emit/flush/shutdown, and user notification without exporting partial secrets in errors.
- Add focused tests for pre-confirm cancellation, cancellation during export, exporter timeout/error, and partial-summary messaging.
- Validate with `npm run typecheck`, the focused backfill tests, `npm run test`, and `npm run lint:eslint`.

#### Acceptance criteria

- Backfill can be cancelled or bounded after confirmation without leaving exporter shutdown unattempted.
- User-facing cancellation/error messages do not include token, prompt, command, path, or environment values.
- Tests cover cancellation before export and during export.
- Relevant validation commands pass or an exact Pi-runtime blocker is documented.

- [x] Preserve explicit secret-hygiene checks for project-local `.env` handling

#### Why

The project contains a real `.env` file and the extension intentionally supports reading trusted project `.env` files in `src/config/load-config.ts`. The package dry-run excludes `.env`, and this review did not print secret values, but future changes around config loading, diagnostics, or package contents could accidentally expose credentials.

#### How to resolve

- Review `.gitignore`, `package.json` `files`, `scripts/check-package-contents.mjs`, `src/config/load-config.ts`, and diagnostic rendering paths.
- Add or maintain tests/checks that prove `.env` is not packaged, not included in dry-run output, not logged, and not rendered by `/obs status`, `/obs health`, or diagnostic errors.
- Ensure trusted project `.env` loading remains behind the existing project-trust boundary.
- Validate with `npm run check:pack`, config-loader tests, command diagnostic tests, and `npm audit --omit=dev --audit-level=moderate`.

#### Acceptance criteria

- Package checks fail if `.env` or other non-example secret files are included.
- Config and command diagnostics never render actual token/password/header values from `.env`.
- Trusted project `.env` loading remains covered by tests for trusted and untrusted project contexts.
- Remaining secret-handling risk, if any, is documented with the exact follow-up action.

## Blocked checks or areas not reviewed

- No live Pi TUI command invocation was run during this pass.
- No destructive dependency updates, audit fixes, or package publishing commands were run.
- The contents of `.env` were intentionally not read or reported.
