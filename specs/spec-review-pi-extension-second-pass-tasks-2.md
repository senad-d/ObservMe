# Second-pass Pi extension review tasks

Review scope and date: 2026-07-07. Maintainability, clean-code, logic, type-safety, and test-gap review for the current ObservMe project state. Existing second-pass spec files were present, so this variant was created. No implementation changes were made.

## Files or areas reviewed

- Command dispatcher and public command modules: `src/commands/obs.ts`, `src/commands/obs-backfill.ts`, selected `src/commands/obs-*.ts` query commands.
- Core lifecycle handler module: `src/pi/handlers.ts`.
- Query transport and readiness helpers: `src/query/grafana-transport.ts`, `src/query/grafana-readiness.ts`, `src/query/loki.ts`, `src/query/prometheus.ts`, `src/query/tempo.ts`.
- Config schema/loader and TypeScript configuration: `src/config/*.ts`, `tsconfig.json`, `eslint.config.js`.
- Existing tests and specs: `test/**/*.mjs`, `test/**/*.ts`, existing `specs/spec-review-pi-extension-*-tasks.md`.

## Safe commands run and results

- `npm run typecheck` — passed.
- `npm run test` — passed, 245 tests.
- `npm run lint:eslint && npm run format:check && npm run check:pack` — passed.
- Read-only `rg`/`find` inspections were used to map public APIs, test files, assertions, high-risk casts, non-null usage, command parsing, transport behavior, and prior review specs.

## Findings summary by severity and category

- Medium / Type Safety: TypeScript test files are outside the current type-check project.
- Medium / Clean Code: `src/pi/handlers.ts` is a very large module that mixes registration, parsing, span construction, metrics, runtime state, recovery, and redaction orchestration.
- Medium / Testing: The most important source module, `src/pi/handlers.ts`, has broad tests but lacks structure-level regression tests that protect smaller extracted parser/attribute helpers if the file is refactored.
- Low / Architecture: Public command argument parsing is hand-rolled in each command; existing coverage is strong, but future command additions can drift in validation and help-text behavior.

## Ordered tasks

- [x] Split `src/pi/handlers.ts` into focused lifecycle, parser, and attribute modules without changing behavior

#### Why

`src/pi/handlers.ts` is roughly 2,700 lines and combines Pi event registration, safe-handler error capture, config/recovery, span lifecycle, metric recording, attribute parsing, redaction hooks, and helper utilities. It is well covered, but the size makes future correctness and privacy reviews expensive and increases the chance that a small change to one event flow breaks unrelated handler behavior.

#### How to resolve

- Identify seams in `src/pi/handlers.ts` for extraction, such as session lifecycle, LLM/tool/bash handlers, branch/compaction helpers, read/normalize helpers, and metric-label builders.
- Move cohesive groups into new internal modules under `src/pi/` while preserving exported public functions used by tests.
- Keep behavior unchanged and avoid broad rewrites; prefer small extraction commits with focused tests after each seam.
- Ensure no new cyclic dependencies are introduced between handler modules, OTEL SDK code, command runtime-state modules, and query clients.
- Validate with `npm run typecheck`, focused handler/event-mapping tests, `npm run test`, `npm run lint:eslint`, and `npm run check:pack`.

#### Acceptance criteria

- `src/pi/handlers.ts` is reduced to registration/orchestration plus clear imports from focused internal modules.
- Existing public behavior, event attributes, metric labels, redaction behavior, and runtime-state updates are unchanged.
- Tests covering Pi handlers, event mapping, chaos/export failures, and package contents pass.
- The refactor remains focused and does not include unrelated feature changes.

- [x] Add structure-level tests for extracted handler parsing and attribute builders

#### Why

The current suite verifies many end-to-end handler outcomes, but a future refactor of `src/pi/handlers.ts` needs focused tests for helper-level behavior so failures point to the specific parser or builder that changed. This is especially important for redaction, path hashing, branch summaries, token/cost extraction, and low-cardinality metric labels.

#### How to resolve

- Before or during handler extraction, identify helper behavior that should be independently tested: message extraction, tool result finalization, bash payload normalization, branch path hashing, compaction attributes, and optional content capture.
- Add tests that import stable internal helpers only where it improves diagnosability; otherwise create fixture-driven tests that isolate one event type at a time.
- Ensure tests cover empty, malformed, partial, duplicate, and unexpected event shapes.
- Validate with `npm run test`, the new focused test files, `npm run typecheck`, and `npm run lint:eslint`.

#### Acceptance criteria

- Refactoring handler internals can be done with fast, focused tests that fail at the relevant parser/attribute boundary.
- Tests cover malformed or partial Pi event payloads for the extracted behavior.
- Redaction and low-cardinality guarantees remain asserted where content or labels are involved.
- The task does not weaken existing end-to-end handler tests.

- [x] Standardize public command argument parsing and usage rendering

#### Why

The root command dispatcher and subcommands parse strings manually. Current tests cover many commands, but each new command must remember its own normalization, unknown-flag handling, usage text, and notification severity. This creates maintainability risk and can lead to inconsistent user help or validation behavior.

#### How to resolve

- Inventory parsing helpers in `src/commands/obs.ts` and `src/commands/obs-*.ts`, especially `obs-backfill`, `obs-trace`, `obs-link`, and query commands with flags.
- Extract a small internal parser/usage utility only if it reduces duplication without making simple commands harder to read.
- Preserve all existing command aliases, error messages where tests depend on them, and completion behavior.
- Add tests for unknown subcommands, unknown options, missing option values, repeated options, and help/usage consistency.
- Validate with command test files, `npm run test`, `npm run typecheck`, and `npm run lint:eslint`.

#### Acceptance criteria

- Commands share consistent parsing and usage behavior or document why specific commands intentionally differ.
- Unknown arguments and missing values produce actionable warnings without throwing.
- Existing command completions and user-facing behavior remain compatible.
- Relevant tests and validation commands pass.

## Blocked checks or areas not reviewed

- No code refactor was performed during this review.
- Full manual inspection of every dashboard and production-doc paragraph was out of scope for this pass.
- Live Pi TUI invocation and Docker integration tests were not run in this pass.
