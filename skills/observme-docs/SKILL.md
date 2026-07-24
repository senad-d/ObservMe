---
name: observme-docs
description: Answers questions about the ObservMe Pi extension, including installation, /obs commands, configuration, privacy and content capture, OpenTelemetry export, Grafana dashboards, metrics, traces, logs, troubleshooting, compatibility, development, and parent/subagent lineage. Use whenever a user asks how ObservMe works, how to set it up or operate it, or where its behavior is documented.
---

# ObservMe documentation

Use the packaged ObservMe documentation for focused answers and the packaged implementation for exact current behavior. Runtime code, schemas, command registries, semantic-convention constants, and shipped configuration are the source of truth. Do not modify files unless the user separately asks for changes.

## Resolve packaged paths

This skill and its references ship in the same installed Pi package. Do not resolve paths against the caller's working directory or assume that an ObservMe repository checkout exists.

1. Use the absolute path from which Pi loaded this `SKILL.md` as `SKILL_FILE`.
2. Set `SKILL_DIR` to the directory containing `SKILL_FILE`.
3. Set `PACKAGE_ROOT` to the absolute path obtained by resolving `../..` from `SKILL_DIR`.
4. Treat every `package:<path>` entry below as relative to `PACKAGE_ROOT`, and pass the resolved absolute path to file tools. Never pass the literal `package:` prefix.

For example, `package:docs/configuration.md` resolves to `<PACKAGE_ROOT>/docs/configuration.md`. Start with `package:docs/README.md` only for broad or unclear requests. For a specific request, read the routed document directly. If a routed file is absent, report that the installed package is incomplete; do not silently substitute a similarly named file from the current project.

The repository-only `observability-stack/`, tests, scripts, and package lock are not shipped in npm. Do not claim to inspect those paths from an installed package. Use the packaged local-profile documentation/examples, and point repository-stack implementation questions to the source checkout.

## Route questions

| User intent | Primary document | Optional deeper reference |
| --- | --- | --- |
| Overview, capabilities, install, quick start, command list, telemetry catalog | `package:README.md` | `package:docs/reference/01-requirements-and-scope.md` |
| Project config creation, what to edit, credentials, precedence | `package:docs/configuration.md` | `package:docs/reference/12-configuration-reference.md` |
| Exact config key, environment variable, validation rule, safe default | `package:docs/reference/12-configuration-reference.md` | `package:src/config/schema.ts`, `package:src/config/defaults.ts`, `package:src/config/load-config.ts`, and `package:src/config/validate.ts` |
| Generated project starter | `package:docs/configuration.md` | `package:src/config/bootstrap-project-config.ts` |
| Privacy defaults, prompt/response/tool/Bash capture, redaction, hashing, paths, TLS | `package:SECURITY.md` | `package:docs/reference/06-security-privacy-redaction.md` |
| Metrics, spans, log events, attributes, labels, cardinality | `package:README.md`, section `Available Telemetry` | `package:docs/reference/04-telemetry-semantic-conventions.md` |
| OTLP endpoints, Collector processors/exporters, Tempo, Loki, Prometheus, Mimir | `package:examples/README.md` | `package:docs/reference/05-otel-pipeline-and-collector.md` |
| Local example configuration | `package:examples/observme.yaml` | `package:docs/configuration.md` |
| Production Collector example | `package:examples/collector.yaml` | `package:docs/reference/05-otel-pipeline-and-collector.md` |
| `/obs status`, health, session, cost, trace, link, tools, errors, logs, agents, backfill | `package:README.md`, section `Commands` | `package:docs/reference/08-query-grafana-integration.md` |
| Grafana auth, datasource UIDs, local URL/transport, data visible but commands fail | `package:docs/validation-flow.md` | `package:docs/reference/08-query-grafana-integration.md` |
| Dashboards, panel meaning, drill-downs, PromQL, LogQL, TraceQL, alerts, SLOs | `package:docs/reference/09-dashboards-alerts-slos.md` | `package:README.md`, section `Dashboards and Examples` |
| Deployment, CI, outages, missing traces/logs/metrics | `package:docs/reference/11-deployment-runbooks.md` | `package:docs/validation-flow.md` |
| Supported Pi, Node.js, OTEL, Collector, and Grafana-stack versions | `package:docs/compatibility-matrix.md` | `package:src/pi/compatibility.ts` and `package:package.json` |
| Architecture, lifecycle, extension boundary | `package:docs/reference/02-reference-architecture.md` | `package:docs/reference/07-extension-implementation-blueprint.md` |
| Pi events, sessions, branches, compaction, recovery | `package:docs/reference/03-pi-event-and-session-model.md` | `package:docs/reference/pi-session-format.md` |
| Integrating another Pi extension, orchestrator, subagent runner, process manager, or remote executor | `package:docs/extension-integration.md` | `package:examples/integrations/subagent-runner.ts` |
| Root agents, subagents, tmux, lineage, trace propagation, wait/join | `package:docs/agent-subagent-observability-requirements.md` | `package:docs/reference/03-pi-event-and-session-model.md` |
| Every agent or subagent appears as its own root / missing parent-child lineage | `package:docs/extension-integration.md`, section `Troubleshooting: every agent appears as its own root` | `package:docs/agent-subagent-observability-requirements.md` |
| Tests, validation, release, package checks | `package:docs/reference/10-testing-release-operations.md` | `package:docs/review-validation.md` |
| Source assumptions and upstream documentation basis | `package:docs/reference/13-source-notes.md` | Read a cited upstream source only when the user asks for verification |
| Security vulnerability reporting | `package:SECURITY.md` | None |

## Implementation verification map

Read implementation only when the user asks for exact/current behavior, the documentation is ambiguous, or drift is suspected. Read the smallest owning slice:

| Behavior | Owning packaged source |
| --- | --- |
| `/obs` subcommand names and dispatch | `package:src/commands/obs.ts`; then the matching `<PACKAGE_ROOT>/src/commands/obs-*.ts` file for syntax/query/output |
| Config keys and types | `package:src/config/schema.ts` |
| Defaults | `package:src/config/defaults.ts` |
| Environment mappings and precedence | `package:src/config/load-config.ts` |
| Validation and production safety rules | `package:src/config/validate.ts` |
| Telemetry names | `package:src/semconv/metrics.ts`, `package:src/semconv/spans.ts`, `package:src/semconv/attributes.ts` |
| Live versus merely registered telemetry | `package:src/pi/handler-runtime.ts` plus the relevant `<PACKAGE_ROOT>/src/pi/event-handlers/*.ts` or `package:src/pi/subagent-spawn.ts` recording point |
| Content-capture behavior | `package:src/privacy/content-capture.ts`, `package:src/privacy/redact.ts`, `package:src/privacy/hash.ts` |
| Integration API types and runtime validation | `package:src/integration.ts`, `package:src/pi/integration-api.ts`, `package:src/pi/subagent-spawn.ts` |
| Pi capability policy | `package:src/pi/compatibility.ts` |

## Answer workflow

1. Classify the question using the routing table.
2. Read the primary document only as far as needed, following necessary Markdown links.
3. For exact, disputed, implementation-level, or version-sensitive behavior, verify the smallest source slice from the implementation map.
4. Answer directly and cite the relevant package-relative document path and heading. Include a source path when it resolved ambiguity.
5. If source and documentation conflict, say so, follow the implementation behavior, and identify the documentation as drift. Never prefer a design note over live code.
6. If the user asks only where something is documented, return the shortest matching path and heading.
7. Distinguish live telemetry from reserved names or instruments that are registered without measurements.

## Current limitations that answers must preserve

- `/obs backfill` replays bounded current-session OTEL log records after confirmation; it does not reconstruct historical spans or metrics.
- YAML `environment` and `tenant` do not synchronize their matching resource attributes; set those attributes too. The corresponding environment overrides map both values.
- `workflow.maxDepthWarning` clamps the `subagent_depth` metric label rather than emitting a warning; `workflow.maxFanoutWarning` has no current live read after loading.
- `metrics.labels` is validated but current metric recorders do not apply configured labels.
- `capture.filePaths` is accepted and displayed but has no direct live recording point. `privacy.pathMode` still controls absolute paths embedded in other enabled content, and `pathMode: full` preserves them regardless of `capture.filePaths`.
- The redaction helper has an injectable PII stage, but current live configuration does not supply or enable a PII detector. Do not claim live PII removal.
- `observme_agent_lifetime_duration_ms`, `gen_ai.client.token.usage`, and `gen_ai.client.operation.duration` are registered without current measurements.
- `session.error` plus standalone `pi.model.change` and `pi.thinking.change` spans are reserved rather than live signals; `session.named` is emitted from `session_info_changed`.
- Arbitrary subagent launchers are not automatically correlated; full lineage requires an ObservMe-aware launcher using the integration API and returned environment.

## Safety and accuracy

- Never request, print, or repeat Grafana tokens, OTLP tokens, passwords, hash salts, raw prompts, raw commands, or private paths.
- Recommend process environment variables or a trusted project `.env` for secrets; do not recommend literal credentials in YAML.
- Keep content capture disabled by default. For opt-in capture, keep redaction enabled and require the tenant hash salt.
- Warn that `privacy.pathMode: full` can expose paths embedded in any enabled content field.
- Never suggest workflow, session, agent, trace, span, entry, spawn, or tool-call IDs as Prometheus labels.
- Do not invent commands, options, configuration keys, telemetry names, supported versions, or remediation steps. If packaged documentation and source do not answer the question, state that limitation and point to the closest reference.
