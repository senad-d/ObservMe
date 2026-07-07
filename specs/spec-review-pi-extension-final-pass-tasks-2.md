# Final-pass Pi extension review tasks

Review scope and date: 2026-07-07. Final verification review for the current ObservMe Pi extension focused on core extension lifecycle, public commands, prior-review assumptions, edge cases, and remaining validation gaps. Existing final-pass spec files were present, so this variant was created. No implementation changes were made.

## Files or areas reviewed

- Pi extension entrypoint and lifecycle registration: `src/extension.ts`, `src/pi/handlers.ts`.
- Public command registration and command context expectations: `src/commands/obs.ts`, `src/commands/obs-backfill.ts`, selected `src/commands/obs-*.ts`.
- Stateful session and agent runtime behavior: `src/commands/obs-session.ts`, `src/commands/obs-status.ts`, `src/commands/obs-agents-runtime.ts`, `src/pi/subagent-spawn.ts`.
- Config/trust/query readiness boundaries: `src/config/load-config.ts`, `src/config/validate.ts`, `src/query/grafana-transport.ts`, `src/query/grafana-readiness.ts`.
- Tests, package metadata, and prior generated specs: `test/`, `package.json`, `tsconfig.json`, `specs/spec-review-pi-extension-*-tasks.md`.

## Previous claims or assumptions verified

- Verified: `package.json` declares the Pi extension entry as `./src/extension.ts` and package dry-run includes that source file.
- Verified: `src/extension.ts` default export registers Pi event handlers and the root `/obs` command.
- Verified: safe validation commands pass in the current state: typecheck, unit tests, ESLint, format check, package dry-run, and production-dependency audit.
- Verified: current test count is 245, higher than the earlier review specs' 208-test snapshot, so prior reports are historical and should not be treated as current validation output.
- Partially verified: command and lifecycle behavior is well covered by imported handler tests and smoke scripts, but this pass did not launch an actual Pi TUI/RPC runtime.
- Blocked/not verified: cancellation semantics for long-running command handlers in a real Pi context, especially backfill export after confirmation.

## Safe commands run and results

- `npm run typecheck` — passed.
- `npm run test` — passed, 245 tests.
- `npm audit --omit=dev --audit-level=moderate` — passed, 0 vulnerabilities.
- `npm run lint:eslint && npm run format:check && npm run check:pack` — passed.
- Read-only file mapping and static searches were run with `find` and `rg`.

## Findings summary by severity and category

- Medium / Verification: Real Pi runtime command routing and cancellation semantics remain unverified in this pass.
- Medium / Lifecycle: Backfill has explicit confirmation but needs abort-aware execution after the command starts exporting.
- Medium / Type Safety: Test TypeScript is not included in source type-checking and should be verified as part of final validation.
- Low / Maintainability: Prior review specs contain completed historical tasks; future workers need to execute the new `*-2.md` variants in order and avoid redoing completed work.

## Ordered tasks

- [ ] Add a real Pi runtime verification for command routing, session state, and command cancellation

#### Why

Imported tests prove that handlers and command functions work in harnesses, but the final Pi-specific assumption is whether a real Pi runtime discovers the extension, routes `/obs` commands with the expected context, populates session state before command invocation, and handles cancellation for long-running command handlers. This is especially important for commands that query Grafana or replay backfill telemetry.

#### How to resolve

- Inspect Pi's documented non-interactive or smoke-test modes and choose the safest way to launch this extension without mutating user state.
- Add or document a smoke script that runs the local extension through Pi runtime discovery, verifies `/obs` registration, triggers a minimal `session_start`, and invokes `/obs status` plus `/obs session` through Pi's command path.
- Include a bounded/cancelled command scenario for a query-backed command or backfill test double so cancellation behavior is observable.
- Keep backend credentials optional; skip only network-dependent assertions when Grafana auth is not configured.
- Validate with the new smoke script, `npm run test`, `npm run typecheck`, and `npm run lint:eslint`.

#### Acceptance criteria

- A real Pi runtime path verifies extension discovery and `/obs` command registration.
- `/obs status` and `/obs session` succeed after lifecycle initialization without depending on direct imports of command handlers.
- At least one long-running command path has a tested cancellation or bounded-time behavior.
- Network/backend portions skip with clear reasons when credentials or services are unavailable.

- [ ] Make final validation include TypeScript tests and current review-spec variants

#### Why

The current `npm run typecheck` validates source only, and existing review specs from earlier in the day contain completed tasks and outdated command counts. A later worker could mistakenly rely on older specs or miss type drift in TypeScript tests. Final validation should make the current project state explicit and independently reproducible.

#### How to resolve

- Add the test TypeScript type-checking task from the first-pass variant before treating validation as complete.
- Update validation documentation or scripts so workers know whether to run `spec-review-pi-extension-*-tasks-2.md` or the historical completed specs.
- Ensure generated spec files remain planning artifacts and are not confused with implementation completion.
- Validate with source typecheck, test typecheck, test suite, lint/format, package check, and audit.

#### Acceptance criteria

- Test TypeScript files are included in final validation through an explicit command.
- Documentation or task ordering clearly distinguishes current `*-2.md` review tasks from historical completed specs.
- Validation output records the current test count and commands rather than stale prior-review numbers.
- The task remains documentation/validation focused and does not mark the extension ready to ship.

- [ ] Verify active-session and post-shutdown observability behavior in one deterministic flow

#### Why

The extension has many tests for telemetry emission and shutdown, but final user confidence depends on a deterministic flow that shows what is visible during an active Pi session and what changes after `session_shutdown`. Without this, users can misinterpret missing root spans, empty current-session state, or delayed exporter flushes as failures.

#### How to resolve

- Build on existing handler, OTEL SDK, trace, and Grafana-stack tests to create one documented flow: start session, emit representative LLM/tool/bash/subagent events, inspect active `/obs session`/`/obs trace` expectations, then shut down and verify final export/flush behavior.
- Explicitly assert or document whether the long-lived root `pi.session` span is expected before shutdown.
- Cover exporter timeout/failure messaging without exposing tokens or content.
- Validate with focused tests plus `npm run test`, `npm run typecheck`, and relevant integration smoke when backend services are available.

#### Acceptance criteria

- Active-session behavior and post-shutdown exported behavior are both asserted or documented in one reproducible flow.
- `/obs session`, `/obs trace`, and exporter status messages align with that lifecycle design.
- Secret/content redaction expectations are preserved in the flow.
- Remaining backend blockers are documented with exact prerequisites.

## Unknowns resolved

- The current repository already has improved passing validation compared with earlier specs: 245 tests pass and package dry-run contains 55 files.
- The extension entrypoint and root command registration are simple and directly verified by file inspection plus existing tests.

## Blocked checks or areas not reviewed

- A real Pi TUI/RPC process was not launched during this pass.
- Docker/Grafana integration scripts were not run during this pass because the safe core review already had passing unit and static validation.
- The working-tree `.env` file contents were intentionally not read.
