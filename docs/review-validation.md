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
- `npm run test:coverage` is the remaining generated-output validation command. It writes `coverage/node-test-coverage.txt`; `coverage/` is git-ignored, and `rm -rf coverage` is the cleanup command after review if the artifact is not needed.
- `npm run validate` remains the broader release-oriented validation entry point, but the review checklist records explicit commands so failures can be attributed to source, test, lint, package, smoke, or audit stages.

## Review-closure evidence categories

- **Read-only/check-only** — commands that inspect, type-check, lint, audit, run tests, dry-run packaging, or smoke local deterministic fixtures without publishing or writing tracked files.
- **Generated-output** — commands that write ignored artifacts, such as `npm run test:coverage` writing `coverage/node-test-coverage.txt`; record the path and clean it with `rm -rf coverage` if the artifact is not needed.
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
- **Generated-output:** `npm run test:coverage` when coverage evidence is needed; record `coverage/node-test-coverage.txt` and remove `coverage/` afterward unless the artifact is intentionally retained.
- **Credential/manual:** model-provider, Grafana credential, and interactive Pi TUI checks must use sanitized shape/status evidence only.
