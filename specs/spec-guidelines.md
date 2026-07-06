# Plan: ObservMe Guidelines

## Task Description

Define coding conventions, Pi extension best practices, package-metadata rules, documentation rules, testing rules, security/privacy rules, and isolated smoke-test rules that must govern every future ObservMe implementation change. This spec is a rules reference for the implementation session that follows preparation; it does not implement any of the rules itself.

## Objective

Give a later implementation session (and any reviewer) one place to check "is this change allowed / does this change follow ObservMe conventions" without re-reading the full `ObservMe-Production-Docs/` set every time.

## Relevant Files

- `docs/STRUCTURE.md` — template's baseline Pi extension conventions (factory must stay small, session-scoped resource lifecycle, `promptSnippet`/`promptGuidelines`, file-mutation queue helpers, `peerDependencies` policy). ObservMe extends, does not replace, these rules.
- `eslint.config.js` — enforced lint rules (`@typescript-eslint/consistent-type-imports`, no-unused-vars with `^_` ignore pattern) that all new ObservMe source must satisfy.
- `tsconfig.json` — `strict: true`, `NodeNext` module resolution, `ES2022` target; new modules must compile cleanly under these settings.
- `AGENTS.md` — repo-wide task workflow rule: one task at a time, checkbox marked `x` only when acceptance criteria are met, update `CHANGELOG.md` per change, avoid nesting functions.
- `ObservMe-Production-Docs/06-security-privacy-redaction.md` — canonical redaction/privacy rules.
- `ObservMe-Production-Docs/10-testing-release-operations.md` — canonical test levels, fixtures, cardinality tests, release process.
- `ObservMe-Production-Docs/12-configuration-reference.md` — canonical config validation rules.
- `package.json` — `scripts.validate` pipeline (`lint`, `test`, `check:pack`, `smoke:packaged`, `smoke:handlers`, `smoke:pi-lifecycle`) that every change must keep passing.

## Coding Conventions

- Keep `src/extension.ts` small: it imports feature modules and calls their `register*` functions only. Do not inline command/tool/event logic in `extension.ts`.
- One registration function per feature module (e.g. `registerObsStatusCommand(pi)`, `registerSessionLifecycle(pi)`). Each larger command/tool gets its own file under `src/commands/` or `src/tools/`.
- Do not nest functions (per `AGENTS.md`). Prefer extracted named helpers over closures nested more than one level deep.
- Use `@earendil-works/pi-ai`'s `StringEnum` for TypeBox string-enum schema fields (tool parameters, config enums) instead of hand-rolled unions.
- Use `type`-only imports for types (`@typescript-eslint/consistent-type-imports` is enforced) — e.g. `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`.
- Prefix intentionally unused parameters/vars/caught errors with `_` to satisfy the `no-unused-vars` / `@typescript-eslint/no-unused-vars` ignore patterns (`^_`).
- Every ObservMe event handler must be wrapped so it can never throw into Pi (the `safeHandler(name, fn)` pattern from `07-extension-implementation-blueprint.md` §10). No handler may propagate an exception to the Pi runtime.
- Bound every in-memory collection (span registries, correlation maps) with an explicit max size and an eviction policy; never use unbounded `Map`/`Array` for per-session or per-agent state.
- Metric/attribute/span names must come from `src/semconv/` constants, not inline string literals scattered across handler files — this keeps the naming spec (`04-telemetry-semantic-conventions.md`) enforceable and greppable.
- Use snake_case for ObservMe-owned metric names, always prefixed `observme_`. Use dotted lowercase for span/attribute names (`pi.session`, `pi.agent.run`, `observme.instance.id`). Never introduce a bare `agent.*` namespace — use `pi.agent.*` for Pi lineage and `gen_ai.agent.*` only where the official GenAI convention fits.

## Pi Extension Best Practices

- Do not start long-lived processes, timers, sockets, or file watchers directly in the extension factory (`observme(pi)`). Pi extension factories may run in invocations that never start a session.
- Start OTEL SDK/exporters/timers from `session_start`; stop/flush them from `session_shutdown` with a bounded timeout (`shutdown.flushTimeoutMs`). Never block shutdown indefinitely.
- Define TypeBox schemas, `description`, `promptSnippet`, and `promptGuidelines` for every tool the extension registers (if/when ObservMe registers an agent-facing tool in addition to `/obs` commands); each guideline must name the tool explicitly.
- If any ObservMe code mutates files (expected to be rare/never for core telemetry, but relevant if a future command writes example config), use Pi's file-mutation queue helpers from `@earendil-works/pi-coding-agent` and resolve paths safely — never write outside the resolved trusted scope.
- Read project-local config (`<CONFIG_DIR_NAME>/observme.yaml`) only when `ctx.isProjectTrusted()` is true. Use Pi's exported `CONFIG_DIR_NAME` constant instead of hardcoding `.pi`.
- There is no dedicated Pi "subagent spawned" event — ObservMe must implement lineage propagation and wait/join tracking at the specific wrapping points where a tool/extension launches or waits for another Pi process, not by inventing a fake Pi event.
- Prefer real-time Pi extension events over session-file parsing for live telemetry. Session-file reads are for startup recovery, `/obs session`, and explicit `/obs backfill` only — never continuous tailing.
- Truncate large tool/query outputs and explicitly tell the agent/user when output was truncated (`observme.truncated=true` + original-length attribute).
- Store branch-sensitive state (if any is needed beyond spans) in tool-result `details`, and reconstruct runtime state from the current branch/session on `session_start` rather than assuming continuity across restarts.

## Package Metadata Rules

- Keep Pi core packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) in `peerDependencies` with `"*"`. Never move them to `dependencies`.
- Put non-Pi runtime libraries (all `@opentelemetry/*` packages) in `dependencies`, pinned to exact versions once added; do not assume every `@opentelemetry/*` package shares one major version.
- Put local development-only tools (test runners, linters, formatters, smoke-test scripts) in `devDependencies`.
- Keep `pi.extensions` pointed at the real entry file (`./src/extension.ts`); update it only if the entry file moves.
- Keep `files[]` in `package.json` limited to what actually ships (`README.md`, `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, `docs/**/*.md`, `src/**/*.ts`, `tsconfig.json`); `ObservMe-Production-Docs/` and `observability-stack/` are companion assets and must not be added to `files[]`.
- Remove the `_template` block from `package.json` only after the first real command/tool/event registration replaces the template examples — not before, and not as part of documentation-only prep work.
- Run `npm run lint` after adding any new TypeScript or development script file so ESLint catches unused symbols and import-style drift immediately.

## Documentation Rules

- Every user-visible behavior change (new `/obs` command, new config key, new capture default) must update `README.md`'s Commands/Configuration sections and `CHANGELOG.md` in the same change.
- `SECURITY.md` must stay accurate to the real trust model: what ObservMe reads, executes, writes, and sends over the network, and to which endpoints (Collector/backend/Grafana query APIs).
- Do not restate the full `ObservMe-Production-Docs/` content inside `README.md` — link to it or summarize; the production docs remain the single source of truth for semantics, and this repo's user docs are a thinner "how do I install/use it" layer.
- If `ObservMe-Production-Docs/` and any spec or implementation detail disagree, the production docs win; update the spec/code to match the docs, not the other way around (per explicit user instruction during preparation).
- Keep `docs/STRUCTURE.md`'s "Rename points for a new project" section as a living checklist until every placeholder is resolved; do not delete it prematurely.

## Testing Rules

- Test at the levels defined in `ObservMe-Production-Docs/10-testing-release-operations.md` §1: unit, contract (Pi event payload fixtures), Collector integration, Grafana-stack backend integration, chaos/failure.
- Every event-to-span mapping change needs a corresponding JSON fixture under `test/fixtures/events/` and an assertion of: correct span name, correct `pi.*`/`observme.*`/`gen_ai.*` attributes, no forbidden metric labels, correct parent/child span nesting, absence of optional content unless capture is explicitly enabled.
- Redaction changes require test cases for every secret-pattern category in `06-security-privacy-redaction.md` §5 (AWS keys, GitHub tokens, bearer tokens, OpenAI/Anthropic-like keys, Slack tokens, password/API-key assignments, private-key blocks, URL credentials) plus filesystem-path and environment-variable-dump cases.
- Cardinality tests must assert that workflow IDs, session IDs, agent IDs (current/parent/child), agent-run IDs, spawn IDs, spawn tool-call IDs, trace IDs, span IDs, entry IDs, and raw path/command/prompt/error values never appear as metric labels.
- Failure-mode tests (Collector down, Collector slow, queue full, redaction exception, subagent without propagated context, orphan agent, runaway fan-out/depth) must assert Pi continues running and increments the correct drop/error/orphan/propagation/fan-out/depth counters or histograms — never an unhandled exception.
- Keep `npm run validate` (lint + test + check:pack + smoke:packaged + smoke:handlers + smoke:pi-lifecycle) green before any change is considered complete.

## Security/Privacy Rules

- Default capture policy is `false` for prompts, responses, thinking, tool arguments, tool results, bash commands, bash output, and file paths. Do not flip any of these defaults without an explicit, separately-reviewed decision.
- Every optional content field must pass the full redaction pipeline (size guard → secret detector → PII detector → path scrubber → custom regex → truncation → hashing) before export — no shortcuts, even in debug/dev mode.
- Enabling any content capture without `redactionEnabled: true` must be rejected unless `allowUnsafeCapture: true` is explicitly set, and the extension must surface a visible warning when unsafe capture is active.
- Never derive `pi.workflow.id`/`pi.workflow.root_agent_id`/`pi.agent.id`/`pi.agent.parent_id`/`pi.agent.root_id`/`pi.agent.spawn.id` from raw cwd, username, prompt text, file path, shell command, PID, container name, or hostname — use generated IDs or salted/HMAC hashes with a tenant-specific secret salt.
- Treat parent-process command lines and inherited environment variables used to launch subagents as sensitive; redact before ever exporting them for debugging.
- Production OTLP endpoints must use TLS unless `allowInsecureTransport: true` is explicitly set (localhost/dev only). Secrets (`OBSERVME_OTLP_TOKEN`, `OBSERVME_GRAFANA_TOKEN`, `OBSERVME_HASH_SALT`) come from environment/secure runtime config, never hardcoded in source.
- Reject configuration when metric labels include forbidden high-cardinality fields, when project-local config is read without `ctx.isProjectTrusted()`, or when propagated agent-lineage values are malformed/oversized/contain unsafe characters.
- Log security-relevant state changes (capture settings at startup, lineage propagation on/off, redaction on/off, redaction failures, exporter auth failures, rejected unsafe config) without ever logging the secret values themselves.

## Isolated Smoke-Test Rules

- Use `pi --no-extensions -e .` for isolated manual/interactive smoke testing so no other configured extensions interfere with ObservMe's session/event behavior.
- Do not use `pi -e .` (which loads other configured extensions too) for ObservMe validation unless explicitly asked to test cross-extension interaction.
- Before relying on isolated smoke testing as sufficient validation, first pass `npm run typecheck`, `npm run lint`, and `npm run test`; smoke testing is a final confirmation, not a substitute for automated checks.
- Smoke-test scripts already present in the template (`smoke:discover`, `smoke:packaged`, `smoke:handlers`, `smoke:pi-lifecycle`) must keep passing as ObservMe-specific commands/events are added; extend them rather than replacing them, unless the template's smoke pattern genuinely does not fit an ObservMe-specific case.

## Versioning Policy

- ObservMe extension versioning follows `MAJOR.MINOR.PATCH` per `ObservMe-Production-Docs/07-extension-implementation-blueprint.md` §13. Breaking changes to telemetry semantic conventions require a MAJOR version bump.
- `observme.semconv.version` (per `04-telemetry-semantic-conventions.md` §16) is versioned independently from the extension package version; bump it whenever span/attribute/metric naming changes in a breaking way, even if the package version bump is minor.

## Acceptance Criteria

- Every rule in this document traces back to either the template's own conventions (`docs/STRUCTURE.md`, `eslint.config.js`, `tsconfig.json`, `AGENTS.md`) or a specific `ObservMe-Production-Docs/*.md` source, with no invented rules that contradict those sources.
- No source code is created or modified as a result of this spec.
- This spec and `specs/spec-architecture.md` do not contradict each other on module boundaries, dependency placement, or config precedence.

## Validation Commands

- `test -f specs/spec-guidelines.md` — confirm the file exists.
- `npm run lint` — confirm the unmodified template still passes lint (this spec introduces no code changes).

## Notes

This is a rules reference, not a task list — see `specs/spec-tasks.md` for the actual checkbox-driven implementation plan. If a future implementation session finds a guideline here that conflicts with `ObservMe-Production-Docs/`, the production docs win and this guideline spec should be corrected.
