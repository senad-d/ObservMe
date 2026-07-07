# First-pass Pi extension review tasks

Review scope and date: security, runtime-bug, and high-risk correctness review on 2026-07-07.

Files or areas reviewed: `package.json`, `tsconfig*.json`, `eslint.config.js`, `.gitignore`, `src/extension.ts`, `src/pi/handlers.ts`, `src/pi/subagent-spawn.ts`, `src/config/load-config.ts`, `src/config/schema.ts`, `src/config/validate.ts`, `src/privacy/redact.ts`, `src/query/grafana-transport.ts`, `src/query/grafana.ts`, `src/query/prometheus.ts`, `src/query/loki.ts`, `src/commands/obs.ts`, `src/commands/obs-backfill.ts`, test inventory under `test/`, scripts inventory under `scripts/`, and existing spec filenames.

Safe commands run and results:

- `find . -maxdepth 3 -type f | sort | head -200` — completed; mapped repository shape and generated/state files to avoid.
- `find src -type f | sort` — completed; mapped extension source surface.
- `find test -maxdepth 2 -type f | sort | head -120` — completed; mapped test surface.
- `find specs -maxdepth 1 -type f` — completed; existing first/second/final review specs found, so `-3` variants were created.
- `npm run typecheck` — passed.
- `npm run typecheck:test` — passed.
- `npm run lint:eslint` — passed.
- `npm audit --omit=dev --audit-level=moderate` — passed with 0 vulnerabilities.
- `npm test` — passed, 264 tests.
- `npm run format:check` — passed for 175 files.
- `npm run check` — passed.
- `grep -R "TODO\|FIXME\|eslint-disable\|ts-ignore\| any\|as any\|child_process\|eval\|new Function" -n src test scripts | head -100` — completed; child-process use is limited to test/scripts, not extension runtime.

Findings summary by severity:

- High: duplicate `session_start` can replace the in-memory session without flushing or shutting down the previous SDK/exporter instance.
- Medium: custom redaction regexes are user-configurable and applied directly, creating regex denial-of-service risk on captured content.
- Medium: custom Grafana transport buffers the entire backend response body before parsing.

## Ordered tasks

- [ ] Serialize duplicate session starts and shut down any previous telemetry session before replacement

#### Why

`src/pi/handlers.ts` stores a single `session` variable inside `registerHandlers`. `createSessionStartHandler` starts a new telemetry session and calls `setSession(session)` without first checking whether a prior session is still active. If Pi emits duplicate, reload, or overlapping `session_start` events before `session_shutdown`, the old OpenTelemetry controller can keep exporters/timers/resources alive and lose final flush state. This is a high-impact lifecycle and resource-leak bug.

#### How to resolve

- Inspect `src/pi/handlers.ts` around `registerHandlers`, `createSessionStartHandler`, and `createSessionShutdownHandler`.
- Add an explicit duplicate-session-start path that flushes and shuts down the previous session with `config.shutdown.flushTimeoutMs` before replacing it, or rejects/ignores duplicate starts deterministically.
- Preserve fail-open behavior: shutdown errors must be recorded via existing export/error telemetry and must not throw into Pi.
- Add focused tests in `test/pi-handlers.test.mjs` or `test/handler-internals.test.ts` proving duplicate `session_start` does not leak the first controller and records an actionable outcome.
- Validate with `npm run typecheck`, `npm run typecheck:test`, `npm test`, and `npm run lint:eslint`.

#### Acceptance criteria

- Duplicate or overlapping `session_start` events no longer leave an earlier telemetry controller unflushed or unshut down.
- A focused test covers the duplicate-start path, including controller flush/shutdown calls or deterministic ignore behavior.
- Relevant type checks, tests, and ESLint pass.
- Any remaining Pi lifecycle ambiguity is documented with the exact event sequence that cannot be verified locally.

- [ ] Bound and harden custom redaction regex execution

#### Why

`src/privacy/redact.ts` compiles `privacy.customRedactionPatterns` with `new RegExp(...)` and applies them to captured prompt/tool/bash/log content. A trusted project config can still contain catastrophic-backtracking patterns that block the Pi process while telemetry redaction runs. Existing size guards cap input length, but a much smaller string can still trigger regex denial of service.

#### How to resolve

- Inspect `src/privacy/redact.ts`, `src/config/validate.ts`, and config tests covering `customRedactionPatterns`.
- Add validation or execution safeguards for custom regex patterns, such as rejecting known-dangerous nested quantifier shapes, bounding pattern length/count, and documenting unsupported constructs.
- Ensure invalid patterns or rejected unsafe patterns cause safe config fallback or field drop without exporting raw content.
- Add focused tests for dangerous custom patterns, invalid patterns, and normal accepted patterns.
- Validate with `npm run typecheck`, `npm run typecheck:test`, `npm test -- test/redact.test.mjs test/config-validation.test.mjs` or the project’s available focused equivalent, and `npm run lint:eslint`.

#### Acceptance criteria

- User-configured redaction regexes are bounded or rejected before they can block redaction on captured content.
- Tests prove unsafe/invalid custom patterns fail closed without raw content export and safe custom patterns still work.
- Relevant tests, type checks, and lint checks pass.
- Any remaining regex-risk tradeoff is documented in the validation behavior or security documentation task.

- [ ] Cap Grafana custom-transport response body size

#### Why

`src/query/grafana-transport.ts` reads Node HTTP responses into memory with `Buffer.concat(chunks)` and no maximum response-body guard. A compromised or misconfigured Grafana/proxy endpoint can return an unexpectedly large body and cause memory pressure during `/obs health`, `/obs logs`, `/obs tools`, `/obs cost`, or trace queries.

#### How to resolve

- Inspect `readNodeResponseBody`, `readNodeResponse`, and query result limits in `src/query/grafana-transport.ts`, `src/query/loki.ts`, `src/query/prometheus.ts`, and `src/query/tempo.ts`.
- Add a configurable or fixed maximum response-body byte limit for the custom Node transport and abort/destroy the request when exceeded.
- Return an actionable sanitized error that does not include backend body content or credentials.
- Add focused tests in `test/grafana-transport-consistency.test.mjs` or related query-client tests for oversized responses.
- Validate with `npm run typecheck`, `npm run typecheck:test`, focused Grafana/query tests, and `npm run lint:eslint`.

#### Acceptance criteria

- Custom Grafana transport refuses oversized response bodies before unbounded buffering.
- Oversized responses produce sanitized actionable diagnostics and do not expose body content or secrets.
- Focused tests cover the cap and existing health/query behavior remains passing.
- Relevant validation commands pass.

## Blocked checks or areas not reviewed

- Integration commands requiring live Collector/Grafana services were not run: `npm run test:integration:collector`, `npm run test:integration:grafana-stack`, `npm run validate:grafana-obs`.
- Smoke commands that may spawn Pi/package install flows were inspected via scripts and `npm run check`, but not fully executed individually unless included in `npm run validate`.
- `.env` exists locally but was not read to avoid exposing secrets; `.gitignore` excludes it and package tests cover package secret exclusion.
