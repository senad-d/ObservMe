# Final-pass Pi extension review tasks

Review scope and date: strict final verification review of core Pi extension behavior on 2026-07-07.

Files or areas reviewed: existing review spec filenames, `package.json`, `src/extension.ts`, `src/pi/handlers.ts`, `src/pi/handler-internals.ts`, `src/pi/subagent-spawn.ts`, `src/config/load-config.ts`, `src/config/validate.ts`, `src/commands/obs.ts`, `src/commands/obs-backfill.ts`, `src/query/grafana-transport.ts`, `src/query/grafana.ts`, `src/query/prometheus.ts`, `src/query/loki.ts`, `src/privacy/redact.ts`, and representative tests under `test/` for handlers, commands, config, query clients, redaction, and packaging.

Previous claims or assumptions verified:

- Verified package Pi entry point: `package.json` declares `pi.extensions: ["./src/extension.ts"]` and `src/extension.ts` default export registers handlers and `/obs` command.
- Verified safe baseline checks pass: typecheck, test typecheck, ESLint, unit/contract tests, format check, package/script syntax checks, and production dependency audit.
- Verified `.env` is ignored by `.gitignore` and package content checks exist; local `.env` was not read.
- Verified first-pass lifecycle concern directly in `src/pi/handlers.ts`: duplicate `session_start` replacement has no visible previous-session shutdown path.
- Verified query clients generally validate unsafe raw query inputs and unresolved Grafana credentials before network fetches.

Commands run and results:

- `npm run typecheck` — passed.
- `npm run typecheck:test` — passed.
- `npm run lint:eslint` — passed.
- `npm audit --omit=dev --audit-level=moderate` — passed with 0 vulnerabilities.
- `npm test` — passed, 264 tests.
- `npm run format:check` — passed for 175 files.
- `npm run check` — passed.
- Repository structure and grep inspection commands listed in the first-pass spec — completed.

Findings summary by severity and category:

- High / Lifecycle + Runtime Correctness: duplicate session-start handling remains the most important verified risk and is cross-referenced from the first-pass spec.
- Medium / Pi Integration + Coverage: no final verification test proves the extension behaves safely when `registerObsCommand` or `registerHandlers` partially fail during default extension initialization.
- Medium / Edge Cases + Query Integration: query result parsing silently converts malformed backend payloads into empty results in some clients, which can mask backend/schema failures as “no data”.

## Ordered tasks

- [ ] Add atomic extension initialization coverage for partial registration failures

#### Why

`src/extension.ts` calls `registerHandlers(pi)` and then `registerObsCommand(pi)` with no explicit rollback or diagnostic behavior if the second registration fails after handlers are already registered. This may leave a partially initialized extension: telemetry handlers active but commands unavailable, or startup failure messages that do not explain what was registered. The project has registration tests, but the final review did not find a focused test for partial default-export initialization failure semantics.

#### How to resolve

- Inspect `src/extension.ts`, `src/pi/handlers.ts`, `src/commands/obs.ts`, and `test/template.test.mjs` / command registration tests.
- Decide and document the intended behavior for partial initialization: fail fast before side effects where possible, or surface a clear diagnostic when rollback is impossible under Pi APIs.
- Add focused tests with a fake Pi API where event registration succeeds and command registration throws.
- If rollback is not possible because Pi registration APIs lack unregister hooks, document that limitation in the test/spec and ensure the thrown error is actionable.
- Validate with `npm run typecheck`, `npm run typecheck:test`, focused extension registration tests, and `npm run lint:eslint`.

#### Acceptance criteria

- A focused test defines and verifies ObservMe’s behavior when default extension initialization partially fails.
- Partial initialization no longer fails silently or with an ambiguous error.
- If rollback cannot be implemented, the limitation and exact Pi API blocker are documented in code comments or tests.
- Relevant validation commands pass.

- [ ] Distinguish malformed query backend payloads from legitimate empty results

#### Why

`src/query/prometheus.ts` and `src/query/loki.ts` parse backend JSON defensively, but malformed or schema-incompatible success payloads can become empty result arrays. For operational commands such as `/obs logs`, `/obs errors`, `/obs cost`, `/obs tools`, and `/obs agents`, this can mislead users into thinking there is no telemetry rather than a Grafana datasource or API-shape problem. Final verification confirmed strict input validation exists, but backend output validation is intentionally loose.

#### How to resolve

- Inspect `readPrometheusQueryResult`, `extractPrometheusQueryResult`, `readLokiLogResults`, and command renderers that convert empty results into recovery hints.
- Define minimum successful payload shapes for Prometheus and Loki datasource responses.
- Return sanitized schema-error diagnostics when `status`/`data`/`result` structures are missing or invalid, while preserving genuine empty vector/stream behavior.
- Add tests with malformed success payloads and legitimate empty payloads for Prometheus and Loki clients plus one command-level rendering path.
- Validate with `npm run typecheck`, `npm run typecheck:test`, focused query tests, and `npm run lint:eslint`.

#### Acceptance criteria

- Malformed successful Prometheus/Loki responses are reported as backend/schema errors, not as normal empty telemetry.
- Legitimate empty responses still render existing no-data recovery hints.
- Diagnostics remain sanitized and do not include tokens, passwords, or raw backend body content.
- Relevant focused tests and validation commands pass.

- [ ] Add a final lifecycle regression test for duplicate `session_start` handling after the first-pass fix

#### Why

The first-pass spec records the implementation task for duplicate `session_start` cleanup. Because this is the core extension lifecycle and resource-safety path, the final pass should require a durable regression test after that fix lands. Without it, future changes to `registerHandlers` or `createSessionStartHandler` could reintroduce leaked controllers/exporters.

#### How to resolve

- Complete or reference the first-pass task in `specs/spec-review-pi-extension-first-pass-tasks-3.md` before this verification task.
- Add a test in `test/pi-handlers.test.mjs` or equivalent that emits two `session_start` events and verifies the first controller is flushed/shut down or that the second start is deterministically ignored.
- Verify status/runtime state (`obs-status`, `obs-session`, and `obs-agents` runtime state where practical) remains consistent after the duplicate-start sequence.
- Validate with `npm run typecheck`, `npm run typecheck:test`, `npm test`, and `npm run lint:eslint`.

#### Acceptance criteria

- Duplicate `session_start` lifecycle behavior has a regression test that fails if previous-session cleanup/ignore semantics are removed.
- Runtime status/session/agent state remains consistent after the tested duplicate-start flow.
- The test cross-references the first-pass lifecycle fix and does not duplicate implementation scope.
- Relevant validation commands pass.

## Unknowns resolved

- Extension entry point and command registration locations were confirmed.
- Safe non-mutating checks all passed in the local environment.
- Existing review spec target filenames already existed, so `-3` variants were used without overwriting earlier review artifacts.

## Blocked checks or areas not reviewed

- Live Collector/Grafana integration tests and smoke commands requiring external services or Pi runtime flows were not run during this review.
- The local `.env` file was not read by design.
- Prior `spec-review-pi-extension-*-tasks.md` and `*-2.md` contents were not modified; earlier claims were not exhaustively reconciled beyond directly verified core lifecycle and public-surface checks.
