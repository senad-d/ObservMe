# Second-pass Pi extension review tasks

Review scope and date: 2026-07-07. Maintainability, clean-code, logic, command design, and test coverage review for ObservMe. No implementation changes were made.

## Files and areas reviewed

- Command dispatcher and command modules under `src/commands/`.
- Grafana/Prometheus/Loki/Tempo query clients under `src/query/`.
- Config schema, defaults, loader, and validation under `src/config/`.
- Runtime status/session/agent state modules: `src/commands/obs-status.ts`, `src/commands/obs-session.ts`, `src/commands/obs-agents-runtime.ts`.
- Pi lifecycle and telemetry handlers: `src/pi/handlers.ts`, `src/pi/subagent-spawn.ts`, `src/pi/agent-lineage.ts`, `src/otel/*.ts`.
- Tests under `test/`, especially command, query-client, handler, dashboard, and integration coverage.
- Local stack and query artifacts under `observability-stack/`, `dashboards/`, and `.pi/observme.yaml`.

## Commands run and results

- `npm run typecheck` — passed.
- `npm test` — passed: 208 tests.
- `npm run lint` — passed.
- `npm run smoke:handlers && npm run smoke:pi-lifecycle` — passed.
- `npm run check:pack` — passed.
- `docker compose -f observability-stack/docker-compose.yml ps` — stack up and healthy.
- Live command-handler reproduction showed query-backed commands failing against the running stack despite existing ObservMe data.
- Direct Prometheus/Loki probes confirmed data exists but command/dashboard Loki selectors do not match live labels.

## Findings summary by severity and category

- High / Testing: Existing tests pass but do not catch the real current-stack `/obs` command failures.
- Medium / Architecture: Grafana URL/header/timeout/auth behavior is duplicated across command and query-client modules, increasing drift.
- Medium / Configuration: The local stack needs a tested, documented profile for Grafana query URL, auth, TLS, datasource UIDs, and resource labels.
- Low / Maintainability: Command failure output is terse and does not consistently include the relevant subsystem or next action.

## Ordered tasks

- [x] Add a live-stack `/obs` command integration test that exercises real Grafana, Prometheus, Loki, and Tempo paths

#### Why

The unit and smoke suites pass, but the current running stack still reproduces user-visible failures: `/obs health` reports Grafana/datasource timeouts and query-backed commands return unavailable errors even though Prometheus and Loki contain ObservMe data. The existing `test/integration/grafana-stack.test.mjs` validates ingestion and dashboards, but the command handlers are not covered end-to-end against the same live backend conditions.

#### How to resolve

- Extend `test/integration/grafana-stack.test.mjs` or add a focused integration test that emits representative ObservMe telemetry, then executes `handleObsCommand` for `status`, `health`, `cost`, `tools`, `errors`, `logs`, `agents`, `trace`, and `link` using the same config path the extension uses.
- Seed or discover a safe session id/trace id so `/obs logs` and `/obs trace --session` can be verified without raw prompts or paths.
- Include authenticated Grafana datasource proxy calls and Loki label assertions so the test fails when auth, URL, TLS, datasource UID, or label strategy is wrong.
- Keep the test opt-in if it starts Docker, but make the command-smoke path runnable against an already-running local stack.
- Validate with `npm run test:integration:grafana-stack` or a new documented command plus the normal `npm run test` suite.

#### Acceptance criteria

- A failing local-stack command regression like the one reproduced on 2026-07-07 is caught by automated tests.
- The integration test proves query-backed commands can return non-error output when telemetry exists and config is valid.
- The test documents required environment/config inputs and skips cleanly when Docker or live-stack prerequisites are unavailable.
- Normal unit tests, lint, and the targeted integration command pass.

- [x] Consolidate Grafana query transport, headers, timeout, token, and error normalization into one shared client layer

#### Why

`src/commands/obs-health.ts` duplicates URL, header, timeout, token-placeholder, and health-target logic that also exists in `src/query/grafana.ts` and the datasource-specific clients. This makes it easy for `/obs health` to report different behavior from `/obs cost`, `/obs tools`, `/obs errors`, and `/obs trace`, and it complicates adding proper local TLS/auth diagnostics.

#### How to resolve

- Introduce or refactor a shared query transport helper used by `src/query/grafana.ts`, `src/query/prometheus.ts`, `src/query/loki.ts`, `src/query/tempo.ts`, and `src/commands/obs-health.ts`.
- Centralize Grafana base URL construction, datasource proxy URL construction, Authorization header creation, unresolved-placeholder handling, timeout/AbortController behavior, TLS/local transport settings, and HTTP error normalization.
- Keep service-specific query validation in the individual Prometheus/Loki/Tempo clients.
- Add tests proving all command modules receive consistent network/auth/timeout errors and secret-safe messages.

#### Acceptance criteria

- There is one tested path for Grafana URL/header/timeout/auth handling across health and query-backed commands.
- Existing query validation remains service-specific and still rejects raw prompts, commands, paths, environment dumps, and high-cardinality labels.
- Tests show a 401, timeout, invalid URL, and success are reported consistently across health and datasource query commands.
- No token value is logged, rendered, or included in thrown errors.

- [x] Define and document a supported local-stack ObservMe query profile

#### Why

The repository includes `.pi/observme.yaml`, `examples/observme.yaml`, a Docker stack, and README command examples, but the live config is not enough for working commands in the current environment. The local stack uses nginx HTTPS, Grafana auth, self-signed/local certificate behavior, datasource UIDs, and Loki labels. Without one tested local profile, users can see data in Grafana while the extension commands fail.

#### How to resolve

- Decide the supported local command path: authenticated Grafana over nginx HTTPS, direct published Grafana HTTP port, or another explicit local URL.
- Update `examples/observme.yaml`, `README.md`, `observability-stack/README.md`, and relevant config docs with the exact `query.grafana.url`, datasource UIDs, token setup, TLS/local certificate instructions, and expected `service.name`/Loki label behavior.
- Add a config test or smoke check that loads the documented local profile and verifies it is internally consistent.
- Include troubleshooting notes for “data visible in Grafana but `/obs` commands fail”.

#### Acceptance criteria

- A user can copy the documented local profile, supply only the documented secret/token inputs, and run `/obs health` successfully against the stack.
- Documentation explains whether browser login cookies are irrelevant to extension commands and how to create/use the required Grafana token without exposing it.
- Tests or smoke checks verify the documented datasource UIDs, local URL shape, and key labels match the stack provisioning.
- The README and examples no longer imply that the current placeholder token config is sufficient for query commands.

- [x] Improve query-command diagnostics and recovery hints without broad rewrites

#### Why

Current errors such as `Prometheus query timed out`, `Loki query timed out`, or `No current ObservMe session id is available` do not tell the user whether the problem is auth, URL, datasource UID, local TLS/DNS, no active session, no telemetry yet, or a query-label mismatch. This slows investigation and makes a working backend look broken.

#### How to resolve

- Update command render/error paths in `src/commands/obs-health.ts`, `src/commands/obs-cost.ts`, `src/commands/obs-tools.ts`, `src/commands/obs-errors.ts`, `src/commands/obs-logs.ts`, `src/commands/obs-trace.ts`, and `src/commands/obs-agents.ts` to include concise subsystem-specific next actions.
- Keep outputs short and secret-safe.
- Add tests for representative user-facing errors: missing current session, missing Grafana token, unauthorized Grafana, timeout, no logs found, no metrics found, and no trace found.

#### Acceptance criteria

- Each query-backed `/obs` command reports the failed subsystem and one concrete next action.
- Existing successful command outputs stay compact.
- Error-output tests prove no raw prompts, paths, command text, environment dumps, or token values appear.
- The task does not include unrelated command rewrites.

## Blocked checks or areas not reviewed

- I did not inspect every generated dashboard panel by opening Grafana in a browser; I reviewed JSON selectors and live datasource labels from the stack.
- I did not run the Docker integration suite that creates a separate stack because the current stack was already running and review should avoid disruptive changes.
- I did not execute actual slash commands inside the live TUI process; handler-level reproduction was used instead.
