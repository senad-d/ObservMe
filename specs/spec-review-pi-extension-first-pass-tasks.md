# First-pass Pi extension review tasks

Review scope and date: 2026-07-07. Security, runtime correctness, configuration, backend connectivity, and high-risk command behavior for the ObservMe Pi extension. No implementation changes were made.

## Files and areas reviewed

- Pi extension entrypoint and registration: `src/extension.ts`, `src/commands/obs.ts`, `package.json` Pi metadata.
- Query-backed commands: `src/commands/obs-health.ts`, `src/commands/obs-cost.ts`, `src/commands/obs-tools.ts`, `src/commands/obs-errors.ts`, `src/commands/obs-logs.ts`, `src/commands/obs-trace.ts`, `src/commands/obs-link.ts`, `src/commands/obs-agents.ts`.
- Query clients: `src/query/grafana.ts`, `src/query/prometheus.ts`, `src/query/loki.ts`, `src/query/tempo.ts`.
- Configuration and validation: `src/config/defaults.ts`, `src/config/load-config.ts`, `src/config/schema.ts`, `src/config/validate.ts`, `.pi/observme.yaml`.
- Telemetry emission and runtime state: `src/pi/handlers.ts`, `src/otel/*.ts`, `src/pi/agent-lineage.ts`, `src/pi/subagent-spawn.ts`.
- Local observability stack: `observability-stack/docker-compose.yml`, `observability-stack/nginx/nginx.conf`, `observability-stack/config/otel/otel-collector.yaml`, `observability-stack/config/grafana/provisioning/datasources/datasources.yaml`.
- Dashboard/query selectors: `dashboards/observme-*.json`.
- Pi extension API docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.

## Commands run and results

- `npm run typecheck` — passed.
- `npm test` — passed: 208 tests.
- `npm run lint` — passed: typecheck, ESLint, format check, script syntax checks.
- `npm run smoke:handlers && npm run smoke:pi-lifecycle` — passed.
- `npm run check:pack` — passed, package dry-run contained 50 files.
- `npm audit --omit=dev` — passed, 0 vulnerabilities.
- `docker compose -f observability-stack/docker-compose.yml ps` — local Grafana/Loki/Tempo/Prometheus/Collector stack was up and healthy.
- Live command-handler reproduction with `.pi/observme.yaml` and trusted project context:
  - `/obs status` rendered local status.
  - `/obs health` reported Collector reachable but Grafana and all datasources timed out.
  - `/obs cost`, `/obs tools`, `/obs errors` timed out querying Grafana-backed datasources.
  - `/obs logs` reported no current ObservMe session id in the separate harness process.
  - `/obs trace` reported no current trace in the separate harness process.
- Direct local stack probes:
  - Prometheus contained ObservMe metrics, including `observme_sessions_started_total`, `observme_tool_calls_total`, and `observme_llm_cost_usd_total`.
  - Loki labels were `event_name`, `exporter`, `pi_agent_id`, and `pi_session_id`; `service_name` and `event_category` were absent.
  - Direct Loki query `{service_name="observme-pi-extension"} | event_category="error"` returned no streams while `{event_name="session.started"}` returned ObservMe logs.
  - Grafana datasource/proxy requests without auth returned 401 when forced to the local nginx endpoint.
  - Node network calls to `observability.local:443` timed out unless forced to IPv4/`127.0.0.1`.

## Findings summary by severity

- High: Query-backed `/obs` commands cannot reliably connect/authenticate to the running local Grafana stack even while data exists in Prometheus/Loki/Tempo.
- High: Loki command and dashboard selectors use labels that the running Collector/Loki pipeline does not actually produce.
- Medium: Local Grafana auth/TLS/DNS failures are collapsed into generic timeouts/unavailable messages, making user remediation difficult and risking secret-handling mistakes.

## Ordered tasks

- [x] Make Grafana-backed `/obs` commands connect and authenticate against the local stack reliably

#### Why

The running stack has ObservMe data, but live command reproduction showed `/obs health` timing out for Grafana and datasource checks, and `/obs cost`, `/obs tools`, and `/obs errors` timing out. Direct forced-local requests showed unauthenticated Grafana datasource/proxy endpoints return 401. Node connections to `observability.local:443` also timed out unless forced to IPv4/`127.0.0.1`. This makes the extension appear broken even when telemetry ingestion and dashboards have data.

#### How to resolve

- Inspect and update `src/query/grafana.ts`, `src/query/prometheus.ts`, `src/query/loki.ts`, `src/query/tempo.ts`, and `src/commands/obs-health.ts` so local Grafana transport, TLS, DNS/IPv4 behavior, timeouts, and auth failures are handled intentionally.
- Add configuration support or documented behavior for local dev HTTPS with self-signed certificates, IPv4 loopback access, Grafana bearer/service-account tokens, and missing-token cases without exposing token values.
- Make `/obs health` distinguish Collector reachability, Grafana network/TLS failure, Grafana 401/403 auth failure, and datasource health failure.
- Add focused tests that reproduce the current failure modes: unresolved token placeholder, missing token 401, self-signed/local Grafana URL, timeout, and a successful authenticated datasource query.
- Validate with `npm run typecheck`, `npm test`, `npm run lint`, and a live-stack command smoke against `observability-stack`.

#### Acceptance criteria

- `/obs health`, `/obs cost`, `/obs tools`, `/obs errors`, `/obs agents`, and `/obs trace --session <safe-session-id>` can query the running local stack when valid Grafana auth and local transport config are supplied.
- Missing/invalid Grafana auth produces an actionable warning/error that does not include secret values and does not masquerade as a generic timeout.
- Local dev TLS/DNS behavior is tested or explicitly documented with a verified supported configuration.
- The relevant tests and validation commands pass.

- [x] Align Loki resource labels, command LogQL, and dashboard selectors with the actual Collector/Loki output

#### Why

The documented commands and dashboards query Loki with selectors such as `{service_name="observme-pi-extension"}` and filters such as `event_category="error"`. The live Loki label set only contains `event_name`, `exporter`, `pi_agent_id`, and `pi_session_id`; `service_name` and `event_category` are absent. Direct live query `{service_name="observme-pi-extension"} | event_category="error"` returned no streams even though ObservMe logs exist. This breaks `/obs errors`, `/obs logs`, and multiple dashboard panels once Grafana connectivity is fixed.

#### How to resolve

- Compare `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md`, `ObservMe-Production-Docs/08-query-grafana-integration.md`, `observability-stack/config/otel/otel-collector.yaml`, `src/config/defaults.ts`, `src/commands/obs-errors.ts`, `src/commands/obs-logs.ts`, and `dashboards/observme-*.json`.
- Decide whether to emit/provision `service.name=observme-pi-extension` and `event.category` as Loki labels, or change commands/dashboards to use the labels the pipeline actually provides.
- Ensure default and local config include the documented `service.name` resource attribute where appropriate.
- Update tests to assert live LogQL selectors match provisioned Loki labels and return seeded ObservMe records.
- Validate with `npm run test`, `npm run lint`, and direct live Loki queries through the stack.

#### Acceptance criteria

- The running stack exposes the labels used by `/obs errors`, `/obs logs`, and Loki-backed dashboard panels, or those queries are changed to use the actual provisioned labels.
- Direct Loki queries for session logs and error events return ObservMe records when records exist.
- `/obs errors` and `/obs logs` have tests proving their LogQL selectors work against representative Loki payloads and local stack configuration.
- Documentation, examples, and dashboard selectors do not contradict the implemented Collector/Loki label strategy.

- [ ] Surface unresolved Grafana token and query-configuration problems before running backend queries

#### Why

The project-local `.pi/observme.yaml` configures `query.grafana.token: ${OBSERVME_GRAFANA_TOKEN}`. Query clients currently treat unresolved placeholders as no token and proceed until network/auth failures occur. This hides the root cause from the user and encourages repeated failing backend calls. It also makes it hard to tell whether commands are failing because Grafana is down, TLS/DNS is wrong, or auth was never configured.

#### How to resolve

- Extend query configuration validation or command preflight in `src/config/validate.ts`, `src/query/grafana.ts`, and command loaders to detect unresolved placeholders for query auth and incomplete Grafana URL/datasource config.
- Keep secret-safe behavior: never print token values, only report that the token is missing/unresolved.
- Add command-level diagnostics that point to the config key and supported auth setup.
- Add tests for unresolved placeholders, blank token, configured token, query disabled, and datasource UID missing.

#### Acceptance criteria

- Query-backed commands fail fast with a clear, secret-safe message when `query.grafana.token` is unresolved or required query config is incomplete.
- `/obs status` or `/obs health` reports query auth/config readiness without revealing credentials.
- Tests cover unresolved placeholder handling and prove no token values appear in command output.

## Blocked checks or areas not reviewed

- I did not execute a real interactive Pi slash command in this TUI session; command behavior was reproduced through the command handler in a separate Node process.
- I did not read project `.env` values or secret files.
- I did not run the Docker integration test that starts/stops its own stack because the current user stack was already running and the review was non-mutating.
