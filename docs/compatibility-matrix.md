# ObservMe Compatibility Matrix

Last updated: 2026-07-14

This matrix records the ObservMe runtime and observability-stack versions exercised or pinned for the current release line. A component is marked **validated** only when the named command actually exercised it; configured CI targets remain distinct from completed local or workflow evidence.

## Pi version policy

ObservMe 0.1.x supports `@earendil-works/pi-coding-agent` `>=0.80.5 <0.81.0`. The Pi-mandated core package peers remain in `peerDependencies` with `"*"`, while release development dependencies are pinned exactly to 0.80.6 and CI installs both the 0.80.5 minimum and the 0.80.6 release-resolved target explicitly. Extension startup checks Pi's exported `VERSION` and required APIs before registering any handler or command.

The 0.80.5 minimum is evidence-based: its exported extension contract includes `session_info_changed`, which ObservMe requires for live rename metadata; 0.80.2 does not. Pi's current extension overloads do not include `bashExecution`, `model_change`, or `thinking_level_change`. `bashExecution` is an `AgentMessage` role observed through `message_end`, while model and thinking changes are session entry types represented at runtime by `model_select` and `thinking_level_select`; ObservMe no longer registers those three non-event names.

## Validation record

| Date | Environment | Command | Coverage |
| --- | --- | --- | --- |
| 2026-07-07 | Local Node.js v26.0.0, npm 11.12.1 | `npm run validate` | Typecheck, ESLint, formatting, unit tests, package contents, packaged install smoke, handler smoke, Pi lifecycle smoke. Does not start Docker Compose. |
| 2026-07-07 | Local Docker 29.5.2 with Collector Contrib 0.104.0 | `npm run test:integration:collector` | Starts a local debug-exporter Collector container, exports representative ObservMe traces/metrics/logs, and asserts default-disabled content capture is absent. |
| 2026-07-07 | Local Docker 29.5.2 with the pinned Grafana stack | `npm run test:integration:grafana-stack` | Starts `observability-stack/` services, exports representative ObservMe telemetry, queries Tempo by trace ID and lineage attributes, queries Loki by session ID, queries Prometheus token totals, and validates Grafana dashboard provisioning imports. |
| Continuous integration target | GitHub Actions `ubuntu-latest`, Node.js 22.19.0 | `npm ci --ignore-scripts` then `npm run validate` | CI target from `.github/workflows/ci.yml`; record the workflow run URL here after each release validation. |
| Pi compatibility CI matrix (configured 2026-07-14) | GitHub Actions `ubuntu-latest`, Node.js 22.19.0; exact Pi 0.80.5 and 0.80.6 matrix targets | Exact Pi install, version assertion, then `npm run validate:pi-compatibility` | Compile-time event fixtures, compatibility diagnostics, package install, handler/lifecycle smoke, and a real Pi RPC runtime are exercised separately at the declared minimum and release-resolved versions. |
| 2026-07-14 | Local Node.js v26.0.0, npm 11.12.1; exact `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 0.80.5 | Exact version assertion then `npm run validate:pi-compatibility` | Passed typecheck, typed event contracts, compatibility diagnostics, packaged install, handler/lifecycle smoke, and real Pi RPC runtime at the declared minimum. |
| 2026-07-14 | Local Node.js v26.0.0, npm 11.12.1; exact `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 0.80.6 | Exact version assertion then `npm run validate:pi-compatibility` | Passed the same compatibility suite at the release-resolved version. |
| Lease cancellation CI profile (configured 2026-07-14) | GitHub-hosted Linux `ubuntu-latest` (exact `ImageOS`/`ImageVersion` recorded in the Actions runner log); Node.js 22.19.0; Collector Contrib 0.104.0; Prometheus 2.53.1; Grafana 11.1.0 | `npm run test:active-agent-lease:contracts` then `npm run test:integration:active-agent-lease` | The bounded `lease-cancellation` job validates clean shutdown, `SIGTERM`, and cancellation-oriented `SIGKILL` convergence against the pinned Collector and Prometheus without secrets or a Grafana dependency. Grafana 11.1.0 is the recorded dashboard compatibility baseline validated separately by `npm run test:integration:grafana-stack`. `if: always()` cleanup is best effort; lease expiry is the asserted correctness mechanism. |
| 2026-07-14 | Local Node.js v26.0.0, npm 11.12.1 | `npm run validate` | Passed 493 unit/contract tests plus typecheck, ESLint, formatting, script, package-content, packaged-install, handler, Pi lifecycle, and Pi runtime checks for the lease release candidate. |
| 2026-07-14 | Local Docker 29.5.2, Compose 5.1.4, Collector Contrib 0.104.0 | `npm run test:integration:collector`; Compose config; pinned Collector `validate` | Passed representative OTLP export, Compose interpolation, and the shipped Collector config validation. |
| 2026-07-14 | Local Docker 29.5.2, Collector Contrib 0.104.0, Prometheus 2.53.1 | `npm run test:integration:active-agent-lease` | Passed clean shutdown, `SIGTERM`, and cancellation-oriented `SIGKILL`; the raw claim remained cached while leased activity converged without Collector restart. Labeled containers and the network were absent after cleanup. |
| 2026-07-14 | Local Docker 29.5.2 with the pinned Grafana stack | `npm run test:integration:grafana-stack` | Unrelated pre-existing broad-stack blocker remains: this run timed out with an empty Prometheus total-token vector. That token path does not validate active-agent leases. Cleanup removed all integration containers and networks; focused lease evidence is unaffected. |
| 2026-07-14 | npm package dry run for `@senad-d/observme` 0.1.3 | `npm run pack:dry-run` | Passed with 124 files; metric source, dashboards, alerts, examples, target docs, and `skills/observme-docs/SKILL.md` were present. |

Active-agent lease interpretation additionally requires producer and Prometheus wall clocks to remain within 5 seconds. GitHub-hosted runners satisfy this expectation. Self-hosted runners are supported only with reliable NTP or equivalent synchronization; clock health must be monitored separately from the ObservMe version matrix.

## Runtime and library matrix

| Component | Version tested or pinned | Source of truth | Status | Evidence and notes |
| --- | --- | --- | --- | --- |
| Pi package API | Supported: `@earendil-works/pi-coding-agent` >=0.80.5 <0.81.0; release-resolved `@earendil-works/pi-coding-agent` 0.80.6 and `@earendil-works/pi-ai` 0.80.6 | `package.json` `observmeCompatibility`, exact dev dependencies, `package-lock.json`, `.github/workflows/ci.yml` | Validated locally at minimum and release-resolved versions; exact CI matrix configured | `npm run validate:pi-compatibility` typechecks exported event contracts, tests pre-registration diagnostics, installs the package, runs handler/lifecycle smoke, and launches the real Pi RPC runtime. |
| Node.js | Local: 26.0.0; CI target/minimum: 22.19.0 | `node --version`, `package.json` `engines.node`, `.github/workflows/ci.yml` | Validated locally for 26.0.0; CI target pinned at 22.19.0 | Local validation ran on 26.0.0. CI is configured to validate on 22.19.0, which is also the minimum supported Node.js version. |
| OpenTelemetry JS package set | `@opentelemetry/api` 1.9.1; `@opentelemetry/api-logs` 0.220.0; OTLP proto exporters 0.220.0; `@opentelemetry/resources` 2.9.0; `@opentelemetry/sdk-logs` 0.220.0; `@opentelemetry/sdk-metrics` 2.9.0; `@opentelemetry/sdk-trace-base` 2.9.0; `@opentelemetry/sdk-trace-node` 2.9.0 | `package.json`, `package-lock.json` | Validated locally | `npm run validate` includes the OTEL lifecycle/exporter unit tests under `test/otel-*.test.mjs`. |

## Reference observability-stack matrix

| Component | Version pinned | Source of truth | Status | Evidence and notes |
| --- | --- | --- | --- | --- |
| Collector distribution | `otel/opentelemetry-collector-contrib:0.104.0` | `observability-stack/docker-compose.yml`, `test/integration/collector-debug.test.mjs`, `test/integration/grafana-stack.test.mjs` | Validated locally | `npm run test:integration:collector` verifies the debug-exporter path; `npm run test:integration:grafana-stack` verifies Collector fan-out to Tempo, Loki, and Prometheus. |
| Tempo | `grafana/tempo:2.5.0` | `observability-stack/docker-compose.yml` | Validated locally | `npm run test:integration:grafana-stack` queries the exported ObservMe trace by trace ID and by `pi.agent.id`/`pi.agent.parent_id` lineage attributes. |
| Loki | `grafana/loki:2.9.8` | `observability-stack/docker-compose.yml` | Validated locally | `npm run test:integration:grafana-stack` queries normalized Loki labels for the exported ObservMe session ID. |
| Prometheus/Mimir | `prom/prometheus:v2.53.1`; Mimir not configured | `observability-stack/docker-compose.yml` | Prometheus validated locally; Mimir not configured | `npm run test:integration:grafana-stack` queries exported ObservMe LLM token totals through the Prometheus datasource. Add a Mimir row if a Mimir backend is introduced. |
| Grafana | `grafana/grafana:11.1.0` | `observability-stack/docker-compose.yml` | Validated locally | `npm run test:integration:grafana-stack` validates datasource availability and provisioning import of the ObservMe dashboard pack. |

## Update rules

- Update this file whenever `package.json` `observmeCompatibility`, `package-lock.json`, `.github/workflows/ci.yml`, or `observability-stack/docker-compose.yml` changes a tracked version.
- Add a new validation-record row whenever a release candidate is validated locally, in CI, or against the Docker Compose stack.
- Do not mark backend components as validated unless a command actually started or queried that component.
- Keep workflow IDs, session IDs, agent IDs, trace IDs, and other high-cardinality values out of this document.
