# Second-pass Pi extension review tasks

Review scope and date: maintainability, clean-code, logic, and test-gap review on 2026-07-07.

Files or areas reviewed: `package.json`, `README.md`, `src/commands/obs.ts`, `src/commands/obs-args.ts`, `src/commands/obs-backfill.ts`, `src/commands/obs-status.ts`, `src/commands/obs-session.ts`, `src/config/load-config.ts`, `src/config/validate.ts`, `src/privacy/redact.ts`, `src/query/grafana-transport.ts`, `src/query/grafana.ts`, `src/query/prometheus.ts`, `src/query/loki.ts`, `src/pi/handlers.ts`, `src/pi/subagent-spawn.ts`, `test/*command*.mjs`, `test/config-*.mjs`, `test/grafana-*.mjs`, and `test/pi-handlers.test.mjs`.

Safe commands run and results:

- `npm run typecheck` — passed.
- `npm run typecheck:test` — passed.
- `npm run lint:eslint` — passed.
- `npm test` — passed, 264 tests.
- `npm run format:check` — passed for 175 files.
- `npm run check` — passed.
- Static grep for TODO/FIXME/ignored types/child_process/eval/function constructors — completed; runtime extension code did not show shell/eval usage.

Findings summary by severity and category:

- Medium / Clean Code + Testing: root `/obs` command dispatch is a long if-chain that must be updated in several places for every subcommand, creating registration/completion/test drift risk.
- Medium / Type Safety + Boundary Validation: `registerHandlers` trusts a cast from `unknown` to the Pi event API and fails with generic runtime errors if Pi API shape is missing or incompatible.
- Low / UX + Security Messaging: unsafe-capture warning text can imply redaction even when `allowUnsafeCapture` is set and redaction is disabled.

## Ordered tasks

- [ ] Replace root `/obs` subcommand dispatch duplication with a single typed registry

#### Why

`src/commands/obs.ts` keeps subcommand constants, usage text, completion arrays, option fields, and a long `if` dispatch chain in separate structures. Every new command must update multiple locations consistently. The current tests cover the implemented commands, but this shape creates drift risk for future commands: a command can be added to usage but missed in completions or dispatch, or dispatched with the wrong option object.

#### How to resolve

- Inspect `src/commands/obs.ts`, `src/commands/obs-args.ts`, and command tests under `test/obs-*command*.mjs`.
- Introduce a typed subcommand registry mapping subcommand names to handler functions, option selectors, and usage/completion metadata.
- Preserve default `/obs` behavior as status and preserve current warning text for unknown commands unless tests intentionally update snapshots.
- Add or update tests proving every registered subcommand appears in usage/completions and dispatches through the same registry.
- Validate with `npm run typecheck`, `npm run typecheck:test`, `npm test -- test/obs-command-args.test.mjs test/obs-health-command.test.mjs test/obs-trace-link-command.test.mjs` or the available focused equivalent, and `npm run lint:eslint`.

#### Acceptance criteria

- Root `/obs` subcommands are defined in one typed registry or similarly single source of truth.
- Usage text, completions, and dispatch cannot drift without a failing test.
- Existing command behavior remains covered and tests pass.
- The task remains scoped to command dispatch structure and does not rewrite individual command implementations.

- [ ] Validate Pi event API shape before registering handlers

#### Why

`src/pi/handlers.ts` accepts `pi: unknown` and immediately casts it to `ObservMePiApi`, then calls `api.on(...)`. If a Pi version changes the event API or a test/integration passes an incomplete object, the extension fails with an unhelpful `api.on is not a function` style error. This is a boundary validation and supportability gap for a public extension entry point.

#### How to resolve

- Inspect `src/extension.ts`, `src/pi/handlers.ts`, `dev-shims/pi-coding-agent/index.d.ts`, and `test/template.test.mjs` or `test/pi-handlers.test.mjs`.
- Add a small type guard/assertion for the event API shape before registering lifecycle handlers.
- Surface a concise actionable message when the Pi event API is unavailable, without hiding real handler errors after registration.
- Add focused tests for invalid Pi API input and valid registration.
- Validate with `npm run typecheck`, `npm run typecheck:test`, focused handler/extension tests, and `npm run lint:eslint`.

#### Acceptance criteria

- Invalid or incompatible Pi event API input fails with an explicit ObservMe/Pi API compatibility message.
- Valid Pi API registration still registers all expected handlers.
- Tests cover both valid and invalid boundary cases.
- Relevant validation commands pass.

- [ ] Make unsafe-capture warnings accurately describe redaction state

#### Why

`src/config/validate.ts` emits: “Prompt, response, tool, bash, or path content may be exported after configured redaction.” The warning is triggered by `privacy.allowUnsafeCapture` plus any capture flag. When `privacy.redactionEnabled` is false, content can be exported without redaction by design. The current wording can understate risk and confuse users during configuration review.

#### How to resolve

- Inspect `emitUnsafeCaptureWarning` in `src/config/validate.ts` and tests around unsafe capture warnings.
- Split warning text based on `privacy.redactionEnabled`: one message for redacted capture and a stronger message for unredacted unsafe capture.
- Ensure warning text never includes captured content or secret values.
- Update focused tests in `test/config-validation.test.mjs` or related config tests.
- Validate with `npm run typecheck`, `npm run typecheck:test`, focused config tests, and `npm run lint:eslint`.

#### Acceptance criteria

- Unsafe capture with redaction disabled produces a clear warning that unredacted sensitive content may be exported.
- Unsafe capture with redaction enabled produces accurate redaction-aware wording.
- Tests assert both messages without exposing secrets.
- Relevant validation commands pass.

## Blocked checks or areas not reviewed

- Full implementation-level refactoring was intentionally not performed.
- Live integration paths with real Collector/Grafana services were not run.
- Existing previous review spec findings were not edited or deduplicated; this `-3` spec records only findings verified in this pass.
