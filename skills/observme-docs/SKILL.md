---
name: observme-docs
description: Answers questions about the ObservMe Pi extension, including installation, /obs commands, configuration, privacy and content capture, OpenTelemetry export, Grafana dashboards, metrics, traces, logs, troubleshooting, compatibility, development, and parent/subagent lineage. Use whenever a user asks how ObservMe works, how to set it up or operate it, or where its behavior is documented.
---

# ObservMe documentation

Use the packaged ObservMe documentation to answer questions accurately and point users to the most relevant file and section. Do not modify files unless the user separately asks for changes.

## Resolve packaged documentation paths

This skill and its documentation ship in the same installed Pi package. Do not resolve documentation paths against the current working directory or assume that an ObservMe repository checkout exists.

1. Use the absolute path from which Pi loaded this `SKILL.md` as `SKILL_FILE`.
2. Set `SKILL_DIR` to the directory containing `SKILL_FILE`.
3. Set `PACKAGE_ROOT` to the absolute path obtained by resolving `../..` from `SKILL_DIR`.
4. Treat every `package:<path>` entry below as a path relative to `PACKAGE_ROOT`. Pass the resulting absolute filesystem path to the read tool.

For example, `package:docs/configuration.md` means the absolute equivalent of `<PACKAGE_ROOT>/docs/configuration.md`, regardless of where npm, git, or a local Pi package was installed. Never pass the literal `package:` prefix to a file tool.

Start with `package:docs/README.md` only when the request is broad or its topic is unclear. For a specific request, read the primary document from the routing table directly. Do not load the entire documentation set. If a routed file is absent from `PACKAGE_ROOT`, report that the installed ObservMe package is incomplete instead of silently reading a similarly named file from the current project.

## Route questions

| User intent | Primary document | Optional deeper reference |
| --- | --- | --- |
| Overview, capabilities, install, quick start, command list, telemetry catalog | `package:README.md` | `package:docs/reference/01-requirements-and-scope.md` |
| Project config creation, what to edit, credentials, precedence | `package:docs/configuration.md` | `package:docs/reference/12-configuration-reference.md` |
| Exact config key, environment variable, validation rule, safe default | `package:docs/reference/12-configuration-reference.md` | `package:src/config/schema.ts` only for an implementation-level question or suspected documentation drift |
| Privacy defaults, prompt/response/tool/Bash capture, redaction, hashing, paths, TLS | `package:SECURITY.md` | `package:docs/reference/06-security-privacy-redaction.md` |
| Metrics, spans, log events, attributes, labels, cardinality | `package:README.md`, section `Available Telemetry` | `package:docs/reference/04-telemetry-semantic-conventions.md` |
| OTLP endpoints, Collector processors/exporters, Tempo, Loki, Prometheus, Mimir | `package:examples/README.md` | `package:docs/reference/05-otel-pipeline-and-collector.md` |
| Local example configuration | `package:examples/observme.yaml` | `package:docs/configuration.md` |
| Production Collector example | `package:examples/collector.yaml` | `package:docs/reference/05-otel-pipeline-and-collector.md` |
| `/obs status`, health, session, cost, trace, tools, errors, logs, agents, backfill | `package:README.md`, section `Commands` | `package:docs/reference/08-query-grafana-integration.md` |
| Grafana auth, datasource UIDs, TLS/DNS, data visible but commands fail | `package:docs/validation-flow.md` | `package:docs/reference/08-query-grafana-integration.md` |
| Dashboards, panel meaning, drill-downs, PromQL, LogQL, TraceQL, alerts, SLOs | `package:docs/reference/09-dashboards-alerts-slos.md` | `package:README.md`, section `Dashboards and Examples` |
| Deployment, CI, outages, missing traces/logs/metrics | `package:docs/reference/11-deployment-runbooks.md` | `package:docs/validation-flow.md` |
| Supported Pi, Node.js, OTEL, Collector, and Grafana-stack versions | `package:docs/compatibility-matrix.md` | `package:docs/reference/10-testing-release-operations.md` |
| Architecture, lifecycle, extension boundary | `package:docs/reference/02-reference-architecture.md` | `package:docs/reference/07-extension-implementation-blueprint.md` |
| Pi events, sessions, branches, compaction, recovery | `package:docs/reference/03-pi-event-and-session-model.md` | `package:docs/reference/pi-session-format.md` |
| Integrating another Pi extension, orchestrator, subagent runner, process manager, or remote executor | `package:docs/extension-integration.md` | `package:examples/integrations/subagent-runner.ts` |
| Root agents, subagents, tmux, lineage, trace propagation, wait/join | `package:docs/agent-subagent-observability-requirements.md` | `package:docs/reference/03-pi-event-and-session-model.md` |
| Tests, validation, release, package checks | `package:docs/reference/10-testing-release-operations.md` | `package:docs/review-validation.md` |
| Source assumptions and upstream documentation basis | `package:docs/reference/13-source-notes.md` | Read the cited upstream source only if the user asks for verification |
| Security vulnerability reporting | `package:SECURITY.md` | None |

## Answer workflow

1. Classify the question using the routing table.
2. Read the primary document completely enough to cover the relevant section. Follow only Markdown links that are necessary to resolve the question.
3. Read the deeper reference when the primary document lacks exact details or the user asks for architecture, schema, or implementation depth.
4. Answer the question directly, then cite the relevant package-relative file path and section heading.
5. If the user asks only where something is documented, provide the shortest matching path and section without summarizing unrelated material.
6. If documents conflict, say so. Prefer current user-facing behavior in `package:README.md` and `package:docs/` over design or contributor notes, and identify any apparent drift.
7. Distinguish live telemetry from names marked reserved or registered but not yet recorded.

## Safety and accuracy

- Never request, print, or repeat Grafana tokens, OTLP tokens, passwords, hash salts, raw prompts, raw commands, or private paths.
- Recommend environment variables or a trusted project `.env` for secrets; do not recommend putting credentials in YAML.
- Keep content capture disabled by default. If explaining opt-in capture, keep redaction enabled and mention the hash-salt requirement.
- Never suggest workflow, session, agent, trace, span, entry, or tool-call IDs as Prometheus labels.
- Do not claim arbitrary subagent launchers are automatically correlated; full lineage requires an ObservMe-aware launcher and propagated context.
- Do not invent commands, configuration keys, telemetry names, supported versions, or remediation steps. If the packaged documentation does not answer the question, state that limitation and point to the closest reference.
