# Final-pass Pi extension review tasks

Review scope and date: 2026-07-07. Final Pi-extension verification focused on core extension behavior, runtime assumptions, Pi lifecycle/state, current Grafana-stack behavior, and unresolved gaps from earlier review passes. No implementation changes were made.

## Files and areas reviewed

- Pi extension factory and public command surface: `src/extension.ts`, `src/commands/obs.ts`, `src/commands/obs-*.ts`.
- Pi lifecycle/event handlers and runtime state: `src/pi/handlers.ts`, `src/pi/subagent-spawn.ts`, `src/commands/obs-session.ts`, `src/commands/obs-agents-runtime.ts`, `src/commands/obs-status.ts`.
- Query clients and validation boundaries: `src/query/*.ts`, `src/config/*.ts`, `src/privacy/*.ts`.
- OTEL SDK lifecycle: `src/otel/*.ts`.
- Local backend and dashboards: `observability-stack/`, `dashboards/`, `.pi/observme.yaml`.
- Existing tests and smoke scripts under `test/` and `scripts/`.
- Pi extension API docs, especially command registration, session lifecycle, and mode behavior in `docs/extensions.md`.

## Previous claims or assumptions verified

- Verified: the package exposes one Pi extension entry, `src/extension.ts`, and the default factory registers handlers plus the root `/obs` command.
- Verified: `npm run typecheck`, `npm test`, `npm run lint`, `npm run smoke:handlers`, `npm run smoke:pi-lifecycle`, `npm run check:pack`, and `npm audit --omit=dev` pass.
- Verified: the local observability stack is up and healthy at the Docker service level.
- Verified: ObservMe metrics and logs exist in Prometheus/Loki, so ingestion is not wholly broken.
- Verified: query-backed command handlers fail in a separate Node reproduction against the current stack/config.
- Verified: live Loki labels do not match several command/dashboard selectors.
- Blocked/not verified: actual slash-command invocation inside the current Pi TUI process and whether this exact process has extension runtime state populated.
- Blocked/not verified: browser-authenticated Grafana panels were not interacted with manually beyond backend/log inspection.

## Commands run and results

- `npm run typecheck` — passed.
- `npm test` — passed: 208 tests.
- `npm run lint` — passed.
- `npm run smoke:handlers && npm run smoke:pi-lifecycle` — passed.
- `npm run check:pack` — passed.
- `npm audit --omit=dev` — passed, 0 vulnerabilities.
- `docker compose -f observability-stack/docker-compose.yml ps` — stack services up and healthy.
- Live command-handler reproduction with trusted project context — `/obs status` rendered; Grafana/datasource/query commands failed as documented in the first-pass spec.
- Direct Prometheus/Loki/Tempo probes — telemetry exists; Loki selector mismatch verified; active Tempo traces can show `<root span not yet received>` while the session root span is still open.

## Findings summary by severity and category

- High / Pi Integration: Tests prove harness behavior but do not prove real Pi slash-command routing, command context, and session runtime state in TUI/RPC modes.
- Medium / Lifecycle: Active sessions may have child spans/logs visible while the root `pi.session` span is not exported until shutdown, making live Tempo traces harder to interpret.
- Medium / Runtime State: Query commands that depend on in-process session state (`/obs session`, `/obs logs`, `/obs trace`) need real Pi lifecycle coverage so separate-process and unloaded-extension failure modes are clear.
- Medium / Verification: Current docs and tests do not include a deterministic “data visible in Grafana, commands work too” acceptance flow.

## Ordered tasks

- [ ] Add a real Pi runtime smoke test for `/obs` command registration, command invocation, and session-scoped state

#### Why

The current smoke tests use a custom harness and confirm that handlers and commands can be registered/executed in isolation. They do not prove that a real Pi process discovers the extension, exposes `/obs` through Pi command routing, passes the expected `ExtensionCommandContext`, and shares in-process runtime state from `session_start` with `/obs session`, `/obs logs`, and `/obs trace`. Because the user is testing inside a live Pi session, this is the most important remaining Pi-specific verification gap.

#### How to resolve

- Add a smoke or integration test that launches Pi with the local extension, for example `pi --no-extensions -e .` in the safest supported mode (RPC, print, or another documented non-interactive mode) and verifies `/obs` appears in Pi's command list.
- Exercise `/obs status`, `/obs session`, and `/obs health` through Pi's actual command path, not by directly importing `handleObsCommand` only.
- Ensure the test observes a `session_start` lifecycle path before command invocation so runtime state is populated.
- Cover at least one project-trust/config path so `.pi/observme.yaml` or an equivalent fixture is loaded intentionally.
- Keep credentials optional; skip only the backend-query part when Grafana auth is not configured, but still verify command registration and local status/session behavior.

#### Acceptance criteria

- A real Pi process can discover the package/local extension and list `/obs` as an extension command.
- `/obs status` and `/obs session` run through Pi command routing after `session_start` without reporting unloaded/unknown state when the extension is active.
- Backend-dependent checks are either verified against configured Grafana auth or skipped with a clear reason.
- The smoke test is documented in `package.json` scripts or test docs and passes in the normal local development environment.

- [ ] Decide and verify how active session traces should appear before `session_shutdown`

#### Why

Live Tempo search showed active traces with `<root span not yet received>` while the session is still running. This is expected if the root `pi.session` span is only exported when it ends during `session_shutdown`, but it can make Grafana trace drill-downs confusing during an active Pi session. The user can see some data in Grafana while commands and trace links feel incomplete, so active-session trace behavior needs an explicit design and test.

#### How to resolve

- Review `src/pi/handlers.ts` session-span lifecycle and `src/otel/traces.ts` BatchSpanProcessor behavior.
- Decide whether to keep the long-lived root `pi.session` span until shutdown, add an explicit short `session.started` span/event for live root visibility, periodically flush ended child spans with clearer trace-link messaging, or document that the root appears only after shutdown.
- Update `/obs trace`, dashboards, or docs so active-session trace links explain what users should expect before shutdown.
- Add a test or live-stack integration assertion for both active-session and post-shutdown trace visibility.

#### Acceptance criteria

- Active-session trace behavior is intentional, documented, and covered by a test.
- `/obs trace` output or docs explain when the root `pi.session` span should be visible.
- Post-shutdown traces still include a canonical `pi.session` root span with session/workflow attributes.
- No change introduces unbounded flushing, timers from the extension factory, or blocking behavior in Pi lifecycle handlers.

- [ ] Verify trusted project config loading and command behavior in the same process that exports telemetry

#### Why

The live command reproduction in a separate Node process loaded `.pi/observme.yaml` by explicitly using a trusted context, but it did not share runtime state with the actual Pi session. Real command behavior depends on Pi passing `ctx.isProjectTrusted()`, `ctx.cwd`, `ctx.sessionManager`, UI methods, and in-process globals. If project trust is false or the extension was launched from a different cwd/config path, commands can silently use defaults such as `https://grafana.example.com` or have no current session id.

#### How to resolve

- Add targeted tests around `loadSessionConfig` as called from actual command contexts, not only unit loaders.
- In the real Pi smoke from the first task, assert the loaded config endpoint and query URL match the intended local profile when the project is trusted.
- Add a concise `/obs status` field or debug-safe output that confirms config source/readiness without exposing paths that should be hidden or secret values.
- Document the behavior when a project is untrusted or project-local `.pi/observme.yaml` is not loaded.

#### Acceptance criteria

- A trusted Pi project loads the intended ObservMe config in the same process that handles `/obs` commands.
- An untrusted project does not read project-local config and the command output explains that safe defaults are in use.
- `/obs status` or equivalent diagnostics make config-source/readiness issues discoverable without leaking secrets.
- Tests cover trusted, untrusted, and missing-project-config command contexts.

- [ ] Create a deterministic user-facing validation flow for “Grafana has data and `/obs` commands work”

#### Why

The current repository validates many isolated pieces, but the user's reported state is cross-system: Grafana dashboards show data while extension commands are not working. There is no single deterministic flow that confirms ingestion, labels, Grafana auth/query access, session state, and slash commands all line up.

#### How to resolve

- Create a validation checklist or script that starts from a running stack and active Pi session, then checks Collector ingestion, Prometheus metrics, Loki labels/logs, Tempo traces, Grafana datasource proxy auth, and each `/obs` command.
- Keep the flow secret-safe and avoid reading `.env` or secret files directly; accept required token/config through documented environment variables.
- Store the checklist in docs or as a smoke script, and include expected outputs/failure signatures for the common cases found during this review.
- Reference the flow from README development/troubleshooting sections.

#### Acceptance criteria

- A developer can run one documented validation flow and determine whether failures are ingestion, labels, Grafana auth/query, local TLS/DNS, Pi command registration, or session-state problems.
- The flow verifies at least one Prometheus metric, one Loki log query, one Tempo trace/search, and representative `/obs` commands.
- The flow never prints secret values and does not mutate the running stack except for optional explicitly-triggered test telemetry.
- The flow catches the current reproduced failure mode before a release is considered validated.

## Unknowns resolved

- Data ingestion is partially working: Prometheus and Loki contain ObservMe records.
- Command failures are not explained by TypeScript, lint, unit-test, package, or dependency failures; those checks pass.
- At least two backend integration mismatches are real: Grafana query transport/auth and Loki selector/label alignment.

## Blocked checks or areas not reviewed

- Actual TUI slash command execution in this running Pi session was not accessible through the available tools.
- No secrets, `.env`, Grafana admin password, or Grafana token values were read.
- Browser-authenticated Grafana UI state was not modified or manually queried beyond Docker logs and backend API checks.
