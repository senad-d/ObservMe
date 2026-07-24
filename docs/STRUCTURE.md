# ObservMe repository structure

This guide describes the current repository layout. `package.json` is authoritative for published files and package exports.

## Runtime source

```text
src/
├── extension.ts            # Pi extension entrypoint
├── integration.ts          # public @senad-d/observme/integration API
├── commands/               # /obs root routing and subcommands
├── config/                 # schema, defaults, loading, validation, trusted bootstrap
├── diagnostics/            # bounded diagnostic sanitization
├── otel/                   # session-scoped traces, metrics, logs, OTLP, shutdown
├── pi/
│   ├── event-handlers/     # lifecycle, agent/turn, LLM, tool/Bash, session events
│   ├── handlers.ts         # handler registration facade
│   ├── handler-runtime.ts  # runtime state and metric instruments
│   ├── handler-internals.ts
│   ├── handler-types.ts    # handler, session, and runtime type contracts
│   ├── agent-lineage.ts
│   ├── agent-tree-tracker.ts
│   ├── active-agent-lease.ts
│   ├── compatibility.ts    # Pi API capability checks
│   ├── integration-api.ts
│   ├── integration-registration.ts
│   ├── otel-operation-ownership.ts
│   ├── session-correlation.ts
│   ├── subagent-spawn.ts
│   ├── subagent-types.ts
│   └── terminal-outcome.ts
├── privacy/                # content policy, redaction, hashing, truncation
├── query/                  # Grafana, Tempo, Loki, Prometheus clients
├── safety/                 # query-input and TUI-output bounds
├── semconv/                # telemetry attributes, names, and values
└── util/                   # bounded data structures
```

ObservMe registers no LLM-callable tools and no custom configuration TUI. The extension exposes one `/obs` command with subcommands.

## User and operator assets

```text
README.md                    # installation, commands, telemetry catalog
SECURITY.md                  # implemented trust and privacy model
docs/                        # task guides and technical reference
skills/observme-docs/        # packaged natural-language documentation router
examples/                    # local extension and production Collector examples
dashboards/                  # Grafana dashboards, alerts, and SLOs
observability-stack/         # repository-only local Docker Compose stack
```

The npm package includes the documented files selected by `package.json#files`; `observability-stack/`, tests, scripts, specifications, and repository-only contributor assets are not published.

## Tests and validation

- `test/*.test.mjs` and `test/*.test.ts` cover runtime, config, privacy, commands, dashboards, packaging, and Pi contracts.
- `test/integration/` contains opt-in Docker-backed validation.
- `scripts/` contains package, smoke, coverage, and Grafana validation entrypoints.
- Run `npm run validate` for the default release gate; Docker integration commands remain explicit.

## Change rules

- Keep `src/extension.ts` limited to capability checks and registration; start exporters from `session_start` and clean them up from `session_shutdown`.
- Add `/obs` behavior under `src/commands/` and register it through `src/commands/obs.ts`.
- Add telemetry names under `src/semconv/`, then add a live recording point and update the README catalog to distinguish live from reserved instruments.
- Update docs, examples, the packaged skill, tests, and `CHANGELOG.md` whenever public behavior changes.
