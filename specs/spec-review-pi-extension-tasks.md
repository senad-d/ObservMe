# Pi extension review tasks

## Review scope

- **Date:** 2026-07-15
- **Target:** `@senad-d/observme` 0.1.4
- **Review mode:** Risk-based, single-reviewer assessment
- **Primary entry points:** `src/extension.ts`, `src/integration.ts`, `src/pi/handlers.ts`, `src/commands/obs.ts`

## Coverage

| Area | Status | Evidence or representative files | Notes |
| --- | --- | --- | --- |
| Public Pi surface | Reviewed | `src/extension.ts`, `src/pi/handlers.ts`, `src/commands/obs.ts`, `src/integration.ts` | Checked default export, compatibility preflight, event/command registration, integration discovery, and the relevant Pi extension lifecycle contract. |
| Lifecycle and shared state | Reviewed | `src/pi/handler-runtime.ts`, `src/pi/event-handlers/lifecycle.ts`, `src/pi/subagent-spawn.ts` | Covered startup, replacement, shutdown, active registries, leases, integration transitions, and representative lifecycle tests. |
| Configuration and filesystem boundaries | Reviewed | `src/config/load-config.ts`, `src/config/project-paths.ts`, `src/config/bootstrap-project-config.ts`, `src/config/validate.ts` | Covered trust gating, layer merging, runtime validation, project file creation, lexical path checks, and temporary-directory reproductions. |
| Network and authentication | Reviewed | `src/query/grafana-transport.ts`, `src/query/grafana-readiness.ts`, `src/query/{prometheus,loki,tempo}.ts`, `src/otel/*.ts` | Covered URL/auth handling, response limits, timeouts, custom Node transport, and exporter lifecycle. |
| Privacy and content capture | Partial | `src/privacy/content-capture.ts`, `src/privacy/redact.ts`, `src/privacy/hash.ts`, privacy tests | Redaction orchestration and custom regex validation were reviewed. Direct reading of `src/privacy/secret-patterns.ts` was blocked by the local protected-path policy; its passing tests were observed. |
| `/obs` commands and UI output | Reviewed | `src/commands/*.ts`, command tests | Covered parsing, diagnostics, query/backfill behavior, output rendering, and missing/invalid inputs. |
| Type safety, package, CI, and dependencies | Reviewed | `package.json`, `tsconfig*.json`, `eslint.config.js`, `.github/workflows/ci.yml` | Type-check, lint, package dry-run, unit/contract tests, and production dependency audit passed. No build script exists. |
| Dashboards, docs, examples, and Docker integrations | Partial | `test/dashboards.test.mjs`, `test/examples.test.mjs`, `.github/workflows/ci.yml` | Their automated checks ran, but these artifacts and Docker-backed integrations were not manually reviewed exhaustively. |

## Commands and results

| Command | Result | Relevant evidence or blocker |
| --- | --- | --- |
| `npm run lint` | Passed | Source/test type-checks, ESLint, format check for 244 files, and script syntax checks passed. |
| `npm test` | Passed | 588 tests passed; the synthetic performance test also passed. |
| `npm run check:pack` | Passed | Dry-run package contained 130 files with no missing required or forbidden packaged files. |
| `npm audit --omit=dev --audit-level=moderate` | Passed | Reported 0 vulnerabilities. |
| `node /tmp/pi-observme-review-check.mjs` | Findings reproduced | Safe temporary checks reproduced the symlink escape, accepted backtracking regex, retained Grafana URL credentials, unbounded Loki row limit, and prerelease compatibility mismatch. The 33-character regex input took about 447 ms. |
| `node /tmp/pi-observme-grafana-auth-check.mjs` | Finding reproduced | A local loopback server confirmed that the custom Grafana transport sends credentials embedded in the configured URL. No credential value was printed. |

## Findings summary

| Severity | Count | Categories |
| --- | ---: | --- |
| Critical | 0 | — |
| High | 1 | Performance |
| Medium | 5 | Lifecycle, Correctness, Security, Pi Integration |
| Low | 1 | Pi Integration |

## Tasks

- [x] **REV-001 · High · Performance — Reject custom redaction patterns with exponential backtracking paths**

  **Evidence:** `src/privacy/redact.ts:395-447` validates length, unsupported constructs, and nested quantified groups, but accepts `^(?:a|aa)+$`. `src/privacy/redact.ts:376-379` then compiles the accepted expression with the native backtracking RegExp engine. The targeted check showed that rejecting a 33-character non-match took about 447 ms; longer captured content grows rapidly and runs synchronously in Pi event handlers. Existing tests at `test/config-validation.test.mjs:375-407` cover `(a+)+b` but not ambiguous quantified alternation.

  #### Why

  A documented custom redactor can pass validation and let a short prompt, response, tool result, or Bash output monopolize the Node event loop. Because redaction runs synchronously before telemetry export, timeout and abort handling cannot recover Pi while the expression is evaluating.

  #### How to resolve

  - Strengthen the validator in `src/privacy/redact.ts` to reject ambiguous quantified alternation and other non-linear constructs, or execute custom patterns with a demonstrably linear-time mechanism.
  - Preserve the current fail-closed capture behavior when a pattern is rejected.
  - Add focused validator and capture-pipeline tests using `^(?:a|aa)+$` and representative safe patterns; use a bounded child-process check rather than a fragile micro-benchmark if runtime behavior is tested.

  #### Acceptance criteria

  - `^(?:a|aa)+$` and equivalent exponential-backtracking forms cannot become active custom redactors.
  - Existing supported custom patterns still redact correctly, including optional `(?i)` handling.
  - Adversarial captured input completes or is rejected within a deterministic bounded test, with no raw content exported on failure.
  - `npm run lint` and `npm test` pass.

- [x] **REV-002 · Medium · Lifecycle — Preserve ownership when OTEL shutdown exceeds its timeout**

  **Evidence:** `src/otel/shutdown.ts:47-62` races SDK shutdown against a timer without cancelling or settling the original action. On timeout, `src/otel/sdk.ts:107-116` immediately drops `#sdk` and reports state `shutdown`. The existing unresponsive-SDK test at `test/otel-sdk.test.mjs:163-185` confirms this terminal state, while Pi replacement flows can subsequently start a new session runtime.

  #### Why

  A timed-out provider shutdown can continue indefinitely with exporter timers, queues, or network work still alive, but the controller has discarded the only reference and claims shutdown is complete. Reload, new-session, resume, fork, or duplicate-start flows can then create another provider set in the same process, accumulating unowned resources and duplicate export activity.

  #### How to resolve

  - Represent timed-out shutdown as unresolved cleanup rather than successful terminal shutdown, retaining enough ownership to observe late settlement or perform deterministic follow-up cleanup.
  - Define how session replacement behaves while cleanup is unresolved so a new provider set is not silently overlapped with the old one.
  - Extend controller and lifecycle tests with both eventually-resolving and never-resolving shutdown actions.

  #### Acceptance criteria

  - A timeout does not make an unresolved SDK unreachable or report it as fully shut down.
  - Late shutdown settlement is observed and releases retained ownership without an unhandled rejection.
  - Session replacement has an explicit tested outcome when prior exporter cleanup remains unresolved, with no silent duplicate provider startup.
  - `npm run lint` and the OTEL/lifecycle test suites pass.

- [x] **REV-003 · Medium · Correctness — Reject child-agent identifier collisions before starting integration spans**

  **Evidence:** `src/pi/integration-api.ts:93-105` rejects duplicate `spawnId` values but does not check `childAgentId`. `src/pi/subagent-spawn.ts:240-279` starts and stores the span before `recordAgentTreeSpawn()` registers that child, while `src/pi/agent-tree-tracker.ts:71-81` can retain an existing terminal node. Completion then returns `invalid_terminal_transition` through `src/pi/subagent-spawn.ts:704-724`, leaving a start call that reported success but cannot complete coherently.

  #### Why

  Concurrent starts with different spawn IDs and the same child placeholder, or reuse of a terminal child placeholder, can return success for a lifecycle that is already doomed. One completion terminalizes the shared tree node; the other active span remains until eviction or session shutdown and callers receive a misleading late transition failure.

  #### How to resolve

  - Validate the requested/generated child placeholder against active and retained tree state before creating a span or incrementing spawn telemetry.
  - Either document and enforce child placeholder uniqueness or implement explicit safe reuse semantics; return a discriminated failure before mutation when the request cannot complete.
  - Add integration API tests for concurrent collision, post-terminal reuse, and state/metric immutability after rejection.

  #### Acceptance criteria

  - `startSubagent()` never returns success for a child placeholder that cannot later take a valid terminal transition.
  - A rejected collision creates no span, tree replacement, metric increment, or propagation envelope.
  - Unique children and existing duplicate-spawn protections continue to work.
  - `npm run lint` and the integration/subagent tests pass.

- [x] **REV-004 · Medium · Security — Reject credentials embedded in Grafana base URLs**

  **Evidence:** `src/config/schema.ts:370-389` and `src/query/grafana-readiness.ts:66-78` validate only the URL shape/protocol and allow `URL.username`/`URL.password`. `src/query/grafana-transport.ts:128-136` preserves those fields when building API URLs, and `src/query/grafana-transport.ts:376-380,478-493` passes the URL to the custom Node transport. A loopback reproduction confirmed that an Authorization header derived from the embedded credentials was sent.

  #### Why

  ObservMe already provides separate token and username/password settings and rejects embedded credentials for OTLP endpoints. Allowing them in `query.grafana.url` creates a second, less visible credential source that can be forwarded on requests, behave differently between the default and custom transports, and be accidentally retained in configuration or URL tooling.

  #### How to resolve

  - Reject Grafana URLs containing username or password components during structural/semantic readiness validation before any request.
  - Keep authentication exclusively in `query.grafana.token` or `query.grafana.username/password`.
  - Add default-fetch and custom-transport tests proving that credential-bearing URLs fail before network I/O and diagnostics never include their values.

  #### Acceptance criteria

  - A Grafana URL with either username or password is not query-ready and cannot reach a transport.
  - Separate bearer and Basic authentication continue to work for valid credential-free base URLs.
  - Config/status/error diagnostics identify the safe failure class without rendering credential values.
  - `npm run lint` and the Grafana/config tests pass.

- [x] **REV-005 · Medium · Security — Enforce the project root after resolving filesystem symlinks**

  **Evidence:** `src/config/project-paths.ts:12-20,54-57` checks containment with lexical `resolve()`/`relative()` only. `src/config/bootstrap-project-config.ts:262-270` then creates the parent and writes through that path. A temporary reproduction with `<project>/.pi` symlinked to a sibling directory returned `created` for an apparently in-project path while actually creating `observme.yaml` outside the project root. The same resolver feeds project config and `.env` reads.

  #### Why

  Lexical containment does not establish the actual filesystem target. A trusted project containing a symlinked config directory or environment file can make automatic startup bootstrap write outside the advertised root and make configuration loading consume an out-of-root file, contrary to the resolver's stated trust boundary.

  #### How to resolve

  - Canonicalize the project root and existing target/ancestor components before read or write, then verify canonical containment immediately before the queued operation.
  - Keep new-file creation race-safe and preserve the current no-overwrite behavior and sanitized diagnostics.
  - Add temporary-directory tests for directory symlinks, file symlinks, in-root symlinks, and normal missing paths.

  #### Acceptance criteria

  - Project config and `.env` reads reject symlink targets outside the canonical project root.
  - Bootstrap cannot create `observme.yaml` outside that root through a symlink or junction.
  - Safe in-root paths remain supported, concurrent creation remains idempotent, and failures expose no sensitive target path.
  - `npm run lint` and the config/bootstrap tests pass.

- [x] **REV-006 · Medium · Pi Integration — Apply one bounded, control-safe output policy to every `/obs` notification**

  **Evidence:** `src/config/schema.ts:354-363` gives `query.maxLogs` no upper bound; `src/commands/obs-loki-summary.ts:53-80` accepts any positive value and renders every selected row without `boundObsCommandOutput()`. The targeted check preserved `maxLogs=1000000`. `src/commands/obs-loki-summary.ts:142-146` collapses whitespace but does not remove all terminal control characters, unlike `src/safety/display-bounds.ts`. Other renderers such as `src/commands/obs-status.ts:138-156` also return directly, while only agents/cost/tools consistently use the shared final output bound.

  #### Why

  A supported config or backend response can produce oversized notifications, and backend-controlled Loki fields can retain terminal control characters such as ESC or BEL. This can degrade TUI/RPC behavior and makes output safety depend on which `/obs` subcommand was used.

  #### How to resolve

  - Define explicit upper bounds for query result counts, especially `maxLogs`, at configuration and runtime boundaries.
  - Route every production `/obs` notification through one shared final character/row bound while retaining useful truncation notices.
  - Reuse the shared Unicode/control normalization for backend-derived fields and audit direct renderers for equivalent gaps.

  #### Acceptance criteria

  - Extremely large configured result limits cannot cause an unbounded query result or UI notification.
  - ESC, BEL, C0/C1 controls, line/paragraph separators, and injected newlines cannot alter a rendered row's terminal structure.
  - Every `/obs` subcommand has a deterministic maximum notification size and a focused regression test.
  - Default output remains readable and `npm run lint` plus command tests pass.

- [x] **REV-007 · Low · Pi Integration — Make compatibility checks honor the declared prerelease boundary**

  **Evidence:** `src/pi/compatibility.ts:43-56` accepts any syntactically valid prerelease when major/minor are `0.80` and patch is at least `5`. A targeted check showed `0.80.5-beta.1` passes, despite the public `SUPPORTED_PI_VERSION_RANGE` at `src/pi/compatibility.ts:6` being `>=0.80.5 <0.81.0`. Existing tests assert the range string but do not cover prerelease ordering.

  #### Why

  A prerelease below the minimum stable build can pass the preflight even though its Pi contracts may predate the required `0.80.5` behavior. The diagnostic then overstates compatibility and allows handler registration to begin.

  #### How to resolve

  - Compare detected versions according to the declared supported-range semantics, including prerelease ordering/exclusion.
  - Add boundary cases for the minimum prerelease, the minimum stable release, supported stable patches, and the next minor line.

  #### Acceptance criteria

  - `0.80.5-beta.1` is rejected before registration while `0.80.5` and `0.80.6` remain accepted.
  - The implementation and `observmeCompatibility.pi.supportedRange` stay aligned.
  - `npm run lint` and the compatibility tests pass.

## Blocked or deferred coverage

- `src/privacy/secret-patterns.ts` — direct inspection was blocked by the local protected-credential-path rule because the filename contains `secret`; obtain an explicit safe read authorization before a focused matcher implementation review. The default privacy tests passed, but this is only partial coverage.
- `npm run test:integration:collector`, `npm run test:integration:active-agent-lease`, and `npm run test:integration:grafana-stack` — deferred because they require Docker and create external containers, networks, or stack state. Run them in the dedicated CI/integration environment.
- `npm run smoke:packaged`, `npm run smoke:handlers`, `npm run smoke:pi-lifecycle`, and `npm run smoke:pi-runtime` — deferred because they spawn/install temporary runtimes and were not needed to verify the findings above; CI definitions and existing smoke scripts were sampled instead.
- `npm run test:coverage` — not run because it writes generated `coverage/` artifacts, which this review was not authorized to create.
- Dashboards, long-form reference docs, images, and large fixtures — validated by the passing default suite but not manually inspected exhaustively; perform a separate artifact-focused review for release-signoff coverage.

## Follow-up review tasks

### 8. Replace heuristic custom-regex safety with bounded, compatibility-preserving validation

- [x] **REV-008 · High · Performance/Correctness — Reject non-linear custom redactors without rejecting safe quantified alternatives**

#### Why

The current group scanner blocks repeated alternation indiscriminately but only recognizes unsafe quantifiers through group state. It rejects previously supported safe patterns such as `(?:foo|bar)+`, while an accepted expression composed of adjacent repeated atoms can still exceed a bounded child-process deadline on a short non-match. This leaves the event-loop denial-of-service path open and breaks safe existing configurations.

#### How

- Replace or strengthen the heuristic with a safety mechanism that prevents non-linear native-regex evaluation, such as sound structural analysis or a demonstrably linear-time execution path.
- Keep configuration-time validation and runtime compilation aligned so a pattern cannot pass one boundary and fail or hang at another.
- Preserve fail-closed capture, optional `(?i)` handling, and supported safe quantified alternatives.
- Add bounded subprocess tests for nested quantifiers, ambiguous alternatives, adjacent repeated atoms, and representative safe patterns; do not rely on timing-only micro-benchmarks.

#### Where

- `src/privacy/redact.ts`
- `test/config-validation.test.mjs`
- `test/content-capture-policy.test.mjs`
- `test/redact.test.mjs`

#### Acceptance criteria

- Adjacent or overlapping repetition forms that can cause non-linear backtracking cannot become active custom redactors.
- Known nested-quantifier and ambiguous-alternation attacks remain rejected before captured content is evaluated.
- Safe quantified alternatives with disjoint branches continue to redact correctly, including optional `(?i)` handling.
- Rejection remains fail closed and no raw captured value appears in results, errors, diagnostics, or child-process output.
- `npm run lint` and `npm test` pass.

### 9. Close canonical project-path validation and I/O race windows

- [x] **REV-009 · Medium · Security — Keep project config and environment I/O inside the canonical root during concurrent path changes**

#### Why

Canonical containment is currently checked before ordinary path-based reads and writes. A project-controlled file or ancestor can still be replaced between resolution and I/O, allowing the operation to follow a newly introduced symlink outside the validated root. The current tests cover static symlinks but not concurrent replacement.

#### How

- Couple containment verification with file opening or creation so the validated target cannot be substituted before the operation.
- Preserve exclusive no-overwrite creation, sanitized diagnostics, trusted-project gating, and supported safe in-root paths.
- Fail closed when the platform cannot establish stable target ownership or detects a path mutation.
- Add deterministic race-oriented tests using controlled hooks or synchronization instead of probabilistic filesystem loops.

#### Where

- `src/config/project-paths.ts`
- `src/config/load-config.ts`
- `src/config/bootstrap-project-config.ts`
- `test/config-loader.test.mjs`
- `test/project-config-bootstrap.test.mjs`

#### Acceptance criteria

- Swapping a config file, environment file, or ancestor to an out-of-root symlink during validation cannot cause an out-of-root read or write.
- Bootstrap never overwrites an existing target and cannot create `observme.yaml` outside the canonical project root.
- Normal missing paths and safe in-root targets remain supported according to one documented policy.
- Failures reveal no sensitive canonical or external path details.
- `npm run lint` and the config/bootstrap tests pass.

### 10. Match Pi compatibility checks to the full declared stable SemVer range

- [x] **REV-010 · Low · Correctness — Accept supported stable versions with build metadata while rejecting prereleases**

#### Why

The declared range `>=0.80.5 <0.81.0` uses SemVer ordering, where build metadata does not change precedence. The current parser normalizes a supported value such as `0.80.5+build.1` to `unknown`, so implementation behavior does not fully match the public compatibility range.

#### How

- Parse the supported SemVer forms needed by Pi package versions, including build metadata.
- Ignore build metadata for range comparison while continuing to reject prerelease builds under the stable-only policy.
- Keep the minimum, first unsupported version, package metadata, and diagnostic range derived from the same constants.

#### Where

- `src/pi/compatibility.ts`
- `test/pi-compatibility.test.ts`

#### Acceptance criteria

- `0.80.5+build.1` and supported later stable patches with build metadata are accepted.
- `0.80.5-beta.1`, `0.80.6-rc.1`, malformed versions, versions below the minimum, and `0.81.0` remain rejected before registration.
- Diagnostics never echo malformed unbounded input and still report the declared range.
- `npm run lint` and the compatibility tests pass.

### 11. Document the new security boundaries for Grafana URLs and project-local files

- [x] **REV-011 · Medium · Documentation — Explain credential-free Grafana base URLs and canonical project-path enforcement**

#### Why

The implementation now rejects credentials embedded in `query.grafana.url` and applies canonical-root checks to trusted project config, `.env` reads, and starter-config writes. These user-visible security behaviors are only summarized in the changelog, leaving configuration and troubleshooting references incomplete.

#### How

- Document that Grafana authentication belongs only in the dedicated token or username/password settings and that credential-bearing base URLs fail before network I/O.
- Document the supported project config and `.env` symlink/path policy, fail-closed behavior, and sanitized diagnostics without publishing sensitive path examples.
- Keep configuration, security, query-integration, and troubleshooting references consistent.

#### Where

- `docs/reference/06-security-privacy-redaction.md`
- `docs/reference/08-query-grafana-integration.md`
- `docs/reference/11-deployment-runbooks.md`
- `docs/reference/12-configuration-reference.md`
- `README.md` if a concise operator-facing note is required

#### Acceptance criteria

- Operators can identify why a credential-bearing Grafana URL is rejected and how to configure supported authentication.
- Operators can identify which project-local symlink/path cases are supported or rejected and how ObservMe fails safely.
- Documentation contains no real credentials, machine-local paths, or unsafe copy-paste examples.
- Documentation link/format checks and `npm run lint` pass.

### 12. Centralize safe Grafana URL failure diagnostics

- [x] **REV-012 · Low · Maintainability — Use one credential-safe Grafana URL diagnostic contract across all boundaries**

#### Why

Configuration validation, query readiness, and transport preflight independently construct nearly identical credential-rejection messages. The duplicated wording can drift and produce inconsistent operator guidance or sanitization guarantees.

#### How

- Define one typed failure classification and safe diagnostic formatter in the shared Grafana URL module.
- Reuse it from configuration validation, readiness reporting, URL building, and both transport paths.
- Preserve boundary-specific error codes and fields while keeping credential values out of every message.

#### Where

- `src/query/grafana-url.ts`
- `src/config/validate.ts`
- `src/query/grafana-readiness.ts`
- `src/query/grafana-transport.ts`
- Grafana/config tests

#### Acceptance criteria

- One shared helper owns the operator-facing embedded-credential guidance.
- Validation, readiness, default fetch, and custom transport report consistent safe failure classes before network I/O.
- Tests prove username, password, bearer token, and URL values never appear in diagnostics.
- `npm run lint` and the Grafana/config tests pass.

### 13. Make the remediation change set self-contained and focused

- [x] **REV-013 · Medium · Change Hygiene — Include required modules and separate unrelated repository changes**

#### Why

Tracked imports currently depend on untracked source modules, so the tracked diff alone cannot type-check. The working tree also combines multiple independent remediations with deletion of an unrelated completed task file, making review and rollback unnecessarily risky.

#### How

- Ensure every newly imported production module and its relevant task specification are included in the final change set.
- Restore unrelated deletions or move them into a separately justified change.
- Partition implementation work into focused commits or review units without losing required tests, documentation, or changelog entries.
- Verify the final patch from a clean checkout rather than relying on untracked local files.

#### Where

- `src/config/query-limits.ts`
- `src/query/grafana-url.ts`
- `specs/`
- Git change-set organization

#### Review units

1. **Custom-redaction safety:** `src/privacy/redact.ts` with the redaction, capture-policy, and validation test hunks.
2. **OTEL cleanup ownership:** `src/otel/{sdk,shutdown}.ts`, lifecycle handler/state changes, and OTEL/lifecycle tests.
3. **Child identifier collisions:** the integration API, subagent identity resolution, public failure type, focused tests, and integration guidance.
4. **Canonical project-file I/O:** project path/loading/bootstrap modules, race-focused tests, and the related security, configuration, README, and runbook guidance.
5. **Grafana URL security contract:** `src/query/grafana-url.ts`, validation/readiness/transport consumers, Grafana/config tests, and credential-free URL guidance.
6. **Bounded `/obs` output and query counts:** `src/config/query-limits.ts`, schema/query/command/display-bound consumers, and their focused command/query tests.
7. **Stable Pi compatibility and release metadata:** compatibility parsing/tests plus the synchronized package and lockfile version update.

`CHANGELOG.md` carries the matching release notes for these integrated review units. Files shared by units, including configuration tests and operator documentation, are split by focused hunks rather than duplicated.

#### Acceptance criteria

- Applying the reviewed patch to a clean checkout includes every imported source module and passes type-checking.
- No required production or test dependency remains untracked or omitted from the reviewed change set.
- Unrelated task-file deletion is restored or delivered as a separate explicitly justified change.
- Each review unit has one coherent purpose with its tests, documentation, and changelog entry.
- `git diff --check`, `npm run lint`, and `npm test` pass from the complete change set.
