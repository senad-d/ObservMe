# Review validation

Use this checklist when closing the 2026-07-09 Pi extension review tasks. It records validation for the current checkout only; generated review specs are planning artifacts and do not by themselves mark the extension ready to ship or complete any review task.

## Current review passes

Execute the active review pass backlogs in order. The current checkout contains no active `-2` review variants; treat any restored `-2` files as historical snapshots unless a later review explicitly designates them as the active backlog.

1. First pass — active security, runtime, and high-risk correctness backlog; completed.
2. Second pass — active maintainability, validation, packaging, and test-gap backlog; completed.
3. Final pass — active lifecycle, async-failure, output-bound, runtime-compatibility, and closure-evidence backlog; continue from the first unchecked task until the file is complete.

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
- `npm run check` validates script syntax for the package-content, coverage, smoke, and Grafana validation helpers without executing generated-output or networked flows.
- `npm run smoke:pi-lifecycle` runs handler lifecycle code with an explicit offline config: traces, metrics, logs, and query integration are disabled, and endpoint fields are loopback-only.
- `npm run smoke:pi-runtime` runs a credential-free Pi RPC lifecycle smoke that covers extension reload through a smoke command that calls `ctx.reload()` (the same flow as `/reload`), RPC `new_session` replacement, post-replacement `/obs status` and `/obs session` routing, and sanitized current Pi event shapes for model/thinking changes, agent turns, built-in tool lifecycle events, and `message_end` with local deterministic backends only.
- `user_bash` is the remaining manual event-shape path: current Pi emits it from interactive `!`/`!!` handling, while RPC `bash`/`prompt` commands do not emit it. The automated smoke verifies the installed Pi `UserBashEvent` type contract (`command`, `excludeFromContext`, `cwd`, and no completed-result fields). Manual recipe when a TUI is available: launch Pi with a temporary recorder extension that logs only `typeof command`, `typeof cwd`, `excludeFromContext`, and completed-result field presence; run `!!printf observme-user-bash-shape`; confirm the shape remains pre-execution and contains no raw command/output in recorded evidence.
- `npm run test:coverage` is the remaining generated-output validation command. It writes `coverage/node-test-coverage.txt` and SonarQube-readable `coverage/lcov.info` for the default non-Docker test suite; `coverage/` is git-ignored, and `rm -rf coverage` is the cleanup command after review if the artifacts are not needed. Docker integration coverage is opt-in with `OBSERVME_INCLUDE_INTEGRATION_COVERAGE=1`.
- `npm run validate` remains the broader release-oriented validation entry point, but the review checklist records explicit commands so failures can be attributed to source, test, lint, package, smoke, or audit stages.

## Deferred integration and Pi lifecycle verification checklist

Use this checklist when a review, release candidate, or local operator needs coverage beyond the default static suite. Record only pass/fail summaries, sanitized ids, and cleanup notes; never paste credentials, prompts, raw command text from interactive Pi, or backend secret values.

| Command | Normal CI safe? | Prerequisites | External access and credentials | Side effects, artifacts, and cleanup | Verification scope |
| --- | --- | --- | --- | --- | --- |
| `npm run smoke:discover` | Yes | Dependencies installed; source files present. | None. Imports the declared local Pi extension entry only. | No tracked writes. | Package-level Pi extension declaration and default export discoverability. |
| `npm run smoke:handlers` | Yes | Dependencies installed. | None. Uses the local Pi API harness. | No tracked writes. | Registers the extension and executes one command plus the first agent-facing tool when present. |
| `npm run smoke:pi-lifecycle` | Yes | Dependencies installed. | None. Uses explicit loopback-only, telemetry-disabled config. | No tracked writes. | Registers `session_start`/`session_shutdown` and confirms lifecycle status cleanup without Collector, Grafana, or credentials. |
| `npm run smoke:pi-runtime` | Yes when the `pi` CLI is installed in the test image | A working local `pi` executable, dependencies installed, and permission to spawn a local child process. | No credentials. It deletes inherited `OBSERVME_*` values and uses a deterministic loopback backend. | Creates a temporary project and extension files under the OS temp directory, then removes them; local loopback server only. | Real Pi RPC extension load, `/obs` discovery/routing, reload/new-session replacement, and credential-free event-shape smoke coverage. |
| `npm run smoke:packaged` | Usually release/local only | `npm` available and package dependencies resolvable for a temporary install. | May need npm registry/cache access to install package dependencies; no project credentials. | Runs `npm pack`, creates a temporary project under the OS temp directory, installs the tarball with `--ignore-scripts --no-audit --no-fund --package-lock=false`, and removes the temp directory. | Packaged install layout plus declared Pi extension and skill resources in the installed package. |
| `npm run test:integration:collector` | No | Docker daemon available; Collector image `OBSERVME_COLLECTOR_IMAGE` or `otel/opentelemetry-collector-contrib:0.104.0` pullable or cached. | Docker image pull may require network; no Grafana/model credentials. | Starts a temporary Collector container with loopback-published ports and stops it in test cleanup. | OTLP export to Collector debug pipeline for representative traces, metrics, and logs. |
| `npm run test:integration:active-agent-lease` | No | Docker daemon available; pinned Collector Contrib and Prometheus images pullable or cached; producer and Prometheus clocks within 5 seconds. | Docker image pull may require network; no project, Grafana, or model credentials. | Creates labeled Collector/Prometheus containers and a dedicated network plus local child producers; bounded `finally` cleanup removes all resources. | Clean shutdown, `SIGTERM`, and cancellation-oriented `SIGKILL`; cached raw claim remains while lease-aware activity reaches zero without Collector restart. |
| `npm run test:integration:grafana-stack` | No | Docker Compose available; `observability-stack/docker-compose.yml` and test overlay available; required Grafana/Tempo/Loki/Prometheus images pullable or cached. | Docker image pull may require network; no external Grafana credentials. Test-created local Grafana admin secret is synthetic. | Creates isolated Docker Compose project/networks/containers. May create `observability-stack/secrets/grafana_admin_password` when missing and removes the test-created file during cleanup; also creates temporary command-project files under the OS temp directory. If interrupted, run `docker compose` with the printed project name or remove stale `observme-grafana-it-*` resources. | Live local stack ingestion, datasource queries, `/obs` query commands, and dashboard provisioning imports. |
| `npm run validate:grafana-obs` | No | Running Pi session with ObservMe loaded, reachable Collector/Grafana stack, and recent telemetry. See `docs/validation-flow.md`. | Requires Grafana read credentials from environment variables (`OBSERVME_GRAFANA_TOKEN` or username/password), datasource UIDs, and `OBSERVME_VALIDATION_SESSION_ID`; may access the configured Grafana URL. | Read-only against the configured stack; no file writes expected. Keep terminal output sanitized and omit secrets. | Operator-facing validation that Grafana has ObservMe data and representative `/obs` commands work against the same stack. |

## Final-pass live/package smoke record — 2026-07-09

This record was produced for the final-pass task "Run and record bounded live Pi/package smoke validation before release." The checkout was dirty with active review-remediation changes, so release candidates should rerun the passing non-service commands from a clean worktree before tagging. No credentials were printed or required for the commands below.

| Command | Result | Evidence and notes |
| --- | --- | --- |
| `npm run smoke:discover` | Pass | Discovered 1 declared Pi extension entry file. |
| `npm run smoke:handlers` | Pass | Registered the extension and executed root `/obs`; no agent-facing tools are registered. |
| `npm run smoke:pi-lifecycle` | Pass | Executed `session_start` and `session_shutdown` with offline telemetry disabled. |
| `npm run smoke:pi-runtime` | Pass | Real Pi RPC process discovered `/obs`, covered reload and new-session lifecycle replacement, and executed status/session/health/bounded query commands with deterministic local backends. |
| `npm run smoke:packaged` | Pass | Packed and installed `@senad-d/observme@0.1.0` into a temporary project, then verified the installed Pi extension entries. |
| `npm run check:pack` | Pass | Package dry-run contained 100 expected files and excluded local state/secrets. |
| `npm run test:integration:collector` | Pass | Docker-backed local Collector debug pipeline received representative traces, metrics, and logs without default content capture. |
| `npm run test:integration:grafana-stack` | Fail/blocker | Docker and Docker Compose were available, stack cleanup left no `observme-grafana-it-*` containers or networks, but the test timed out waiting for `Tempo LLM content attributes`: Tempo returned the trace payload without satisfying `hasTempoLlmContentPayload()` for `pi.llm.prompt.redacted`, `pi.llm.response.redacted`, `pi.llm.thinking.redacted`, and marker assertions. Next action: inspect the live-stack Tempo attribute ingestion/query shape around `waitForTempoLlmContent()` in `test/integration/grafana-stack.test.mjs` before release. |
| `npm run validate:grafana-obs` | Blocked/not run | Requires an operator-controlled running Pi session with ObservMe loaded, reachable Grafana/Collector stack, Grafana read credentials via environment variables, and `OBSERVME_VALIDATION_SESSION_ID`; do not run until those prerequisites are available and evidence can stay sanitized. |

Post-run cleanup check: `docker ps --filter name=observme-grafana-it --format '{{.Names}}'` and `docker network ls --filter name=observme-grafana-it --format '{{.Name}}'` returned no resources.

## Active-agent lease release validation — 2026-07-14

This sanitized record covers the production active-agent lease release candidate on local Node.js v26.0.0, npm 11.12.1, Docker 29.5.2, and Docker Compose 5.1.4. The checkout contains the lease implementation and documentation changes. No project, Grafana, model, or registry credentials were required or printed.

| Command | Result | Evidence and notes |
| --- | --- | --- |
| `npm run validate` | Pass | Source/test typechecks, ESLint, formatting, script checks, 493 unit/contract tests, package-content checks, packaged-install smoke, handler smoke, Pi lifecycle smoke, and Pi runtime smoke passed. |
| `npm run test:integration:collector` | Pass | The pinned Collector Contrib 0.104.0 debug pipeline received representative traces, metrics, and logs without default content capture. |
| `npm run test:integration:active-agent-lease` | Pass | Clean shutdown, `SIGTERM`, and cancellation-oriented `SIGKILL` passed against Collector Contrib 0.104.0 and Prometheus 2.53.1. The raw claim remained cached while lease-aware activity reached zero with the same Collector instance and no restart. |
| `npm run test:integration:grafana-stack` | Fail/unrelated pre-existing broad-stack blocker | The current run timed out when the Prometheus total-token query returned an empty vector. This token-ingestion/query path is unrelated to active-agent lease arithmetic, PromQL, or abrupt-termination convergence and does not invalidate the focused passing lease evidence. The earlier 2026-07-09 broad-stack run was already blocked later in its Tempo content assertion. |
| `docker compose -f observability-stack/docker-compose.yml config --quiet` | Pass | Compose interpolation validated without rendering secret values. |
| Pinned Collector Contrib 0.104.0 `validate --config=/etc/otel/otel-collector.yaml` | Pass | The shipped `observability-stack/config/otel/otel-collector.yaml` parsed successfully with the deployed distribution. |
| `npm run pack:dry-run` | Pass | The 124-file package contained the lease source/metric convention, dashboards, alerts, examples, target user/operator/reference docs, and packaged `observme-docs` skill. |

Post-run cleanup check found no containers or networks labeled for the active-agent lease integration and no `observme-grafana-it-*` containers or networks. Release remains blocked on the unrelated broad Grafana-stack validation unless the release owner accepts the explicitly allowed pre-existing blocker; all lease-specific release criteria passed.

## Review-closure evidence categories

- **Read-only/check-only** — commands that inspect, type-check, lint, audit, run tests, dry-run packaging, or smoke local deterministic fixtures without publishing or writing tracked files.
- **Generated-output** — commands that write ignored artifacts, such as `npm run test:coverage` writing `coverage/node-test-coverage.txt` and `coverage/lcov.info`; record the paths and clean them with `rm -rf coverage` if the artifacts are not needed.
- **Docker/integration** — commands that require Docker or the local observability stack, such as `npm run test:integration:collector`, `npm run test:integration:grafana-stack`, and `npm run validate:grafana-obs`.
- **Credential/manual** — checks that require a TUI, model provider credentials, Grafana credentials, or other operator-controlled state; keep recorded evidence sanitized and never paste secrets, prompts, commands, or raw outputs.

## Post-remediation verification matrix

Use this matrix before checking a review task complete. The focused command must directly exercise the task-specific behavior; high-priority tasks must not be closed with broad `npm run test` evidence alone.

| Pass | Task | Priority | Evidence category | Required focused evidence |
| --- | --- | --- | --- | --- |
| First | Apply tenant-salted hashing consistently to telemetry, redaction, and subagent command fingerprints | High | Read-only/check-only | `node --test test/privacy-hash-truncate.test.mjs test/redact.test.mjs test/handler-internals.test.ts test/subagent-spawn.test.mjs test/obs-backfill-command.test.mjs`; then `npm run typecheck`, `npm run typecheck:test`, `npm run lint:eslint`, `npm run test`. |
| First | Enforce production-safe transport for all OTLP signal endpoints and Grafana query credentials | High | Read-only/check-only | `node --test test/config-validation.test.mjs test/grafana-query-client.test.mjs test/obs-health-command.test.mjs`; then `npm run typecheck`, `npm run typecheck:test`, `npm run lint:eslint`, `npm run test`. |
| First | Correct `user_bash` handling so pre-execution Pi events are not recorded as completed bash executions | High | Read-only/check-only plus credential/manual for interactive bash shape | `node --test test/pi-handlers.test.mjs test/event-mapping.test.ts`; `npm run smoke:pi-runtime`; if reviewing the interactive `user_bash` path, follow the sanitized TUI recipe above and record only shape metadata. |
| First | Clear stale ObservMe and W3C context values before propagating subagent environments | Medium | Read-only/check-only | `node --test test/agent-lineage.test.ts test/subagent-spawn.test.mjs test/event-mapping.test.ts`; then `npm run typecheck`, `npm run typecheck:test`, `npm run lint:eslint`, `npm run test`. |
| First | Sanitize health, bootstrap, and transport diagnostics before showing them in Pi UI | Medium | Read-only/check-only | `node --test test/obs-health-command.test.mjs test/grafana-query-client.test.mjs test/project-config-bootstrap.test.mjs test/otel-sdk.test.mjs test/obs-status-command.test.mjs test/obs-command-diagnostics.test.mjs test/sensitive-query-input.test.mjs`; then `npm run typecheck`, `npm run typecheck:test`, `npm run lint:eslint`, `npm run test`. |
| Second | Centralize live and backfill content-capture policy | Medium | Read-only/check-only | `node --test test/content-capture-policy.test.mjs test/handler-internals.test.ts test/obs-backfill-command.test.mjs test/config-validation.test.mjs`; then `npm run typecheck`, `npm run typecheck:test`, `npm run lint:eslint`, `npm run test`. |
| Second | Consolidate sensitive query and diagnostic input validation patterns | Low | Read-only/check-only | `node --test test/sensitive-query-input.test.mjs test/prometheus-query-client.test.mjs test/loki-query-client.test.mjs test/tempo-query-client.test.mjs test/grafana-query-client.test.mjs test/obs-trace-link-command.test.mjs test/obs-command-diagnostics.test.mjs`; then `npm run typecheck`, `npm run typecheck:test`, `npm run lint:eslint`, `npm run test`. |
| Second | Repair validation script and README command drift | Medium | Read-only/check-only | `node --test test/package-contents-check.test.mjs`; `npm run check`; `npm run typecheck`; `npm run lint:eslint`; `npm run test`. |
| Second | Make smoke and coverage validation deterministic, offline, and review-safe | Medium | Read-only/check-only plus generated-output for coverage | `node --test test/validation-scripts.test.mjs`; `npm run check`; `npm run smoke:handlers`; `npm run smoke:pi-lifecycle`; `npm run smoke:pi-runtime`; run `npm run test:coverage` only when generated coverage output is acceptable and record cleanup. |
| Second | Align npm package contents with README-promised assets and examples | Medium | Read-only/check-only | `node --test test/package-contents-check.test.mjs`; `npm run check:pack`; `npm run smoke:packaged`; `npm run test`. |
| Second | Add targeted edge-case tests for synthetic event fallback paths | Low | Read-only/check-only | `node --test test/pi-handlers.test.mjs test/event-mapping.test.ts`; then `npm run typecheck`, `npm run typecheck:test`, `npm run lint:eslint`, `npm run test`. |
| Final | Serialize session lifecycle start, shutdown, reload, and replacement state transitions | High | Read-only/check-only | `node --test test/pi-handlers.test.mjs test/obs-session-command.test.mjs test/obs-status-command.test.mjs test/obs-agents-command.test.mjs`; `npm run smoke:pi-runtime`; then `npm run typecheck`, `npm run typecheck:test`, `npm run lint:eslint`, `npm run test`. |
| Final | Make `/obs backfill` timeout and cancellation stop underlying exporter work | Medium | Read-only/check-only | `node --test test/obs-backfill-command.test.mjs`; then `npm run typecheck`, `npm run typecheck:test`, `npm run lint:eslint`, `npm run test`. |
| Final | Bound `/obs agents` rendered child output for large agent trees | Medium | Read-only/check-only | `node --test test/obs-agents-command.test.mjs`; then `npm run typecheck`, `npm run typecheck:test`, `npm run lint:eslint`, `npm run test`. |
| Final | Add real Pi runtime event-shape compatibility smoke coverage | Medium | Read-only/check-only plus credential/manual for interactive bash shape | `npm run smoke:pi-runtime`; `node --test test/pi-handlers.test.mjs test/event-mapping.test.ts`; if Pi still cannot emit interactive `user_bash` through RPC, record the documented sanitized TUI recipe as the blocker/manual evidence. |
| Final | Create a post-remediation verification matrix for review-task closure | Low | Read-only/check-only | `npm run format:check`; focused documentation consistency check: every row in this matrix names a validation command or blocker, and the categories above classify read-only, generated-output, Docker/integration, and credential/manual evidence. |

## Supplemental release-oriented checks

The matrix above is the minimum closure evidence for the review tasks. Run these broader checks before release or when touching the corresponding surface:

- **Docker/integration:** `npm run test:integration:collector`, `npm run test:integration:grafana-stack`, and `npm run validate:grafana-obs` when Docker and the local observability stack are available.
- **Generated-output:** `npm run test:coverage` when coverage evidence is needed; record `coverage/node-test-coverage.txt` and `coverage/lcov.info`, then remove `coverage/` afterward unless the artifacts are intentionally retained.
- **Credential/manual:** model-provider, Grafana credential, and interactive Pi TUI checks must use sanitized shape/status evidence only.
