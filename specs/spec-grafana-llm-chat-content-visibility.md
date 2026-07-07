# Plan: Grafana LLM Chat Content Visibility

## Task Description

Implement opt-in visibility of redacted LLM chat input, output, and thinking content in both Grafana Tempo traces and Grafana Loki log panels when the existing ObservMe capture flags are enabled:

```text
OBSERVME_CAPTURE_PROMPTS=true
OBSERVME_CAPTURE_RESPONSES=true
OBSERVME_CAPTURE_THINKING=true
OBSERVME_REDACTION_ENABLED=true
OBSERVME_ALLOW_UNSAFE_CAPTURE=true
```

The current extension records redacted LLM prompt/response/thinking values as span attributes, but the bundled Collector deletes those attributes before Tempo receives them. Loki currently receives only content-capture audit events, not the captured redacted content itself. This task changes that behavior for explicitly enabled content capture while preserving privacy-by-default defaults.

Task type: enhancement
Complexity: medium

## Objective

When content capture is explicitly enabled:

- Tempo traces show redacted prompt, response, and thinking content on LLM request spans.
- Loki receives redacted prompt, response, and thinking content as correlated content-capture logs.
- The Grafana LLM logs dashboard exposes the captured redacted content in log panels.
- Defaults remain privacy-preserving: no content is exported unless capture flags are enabled.

## Problem Statement

Users can enable all capture flags and still not see LLM chat input/output in Grafana because the local Collector config deletes `pi.llm.prompt.redacted`, `pi.llm.response.redacted`, and `pi.llm.thinking.redacted` from traces, and the extension emits only audit logs such as `llm.prompt.captured` to Loki. Grafana therefore shows metrics and audit events, but not the redacted chat content the user opted into capturing.

## Solution Approach

Use the existing capture flags and redaction pipeline as the source of truth. Do not add a second content-enable flag unless implementation discovers a hard safety need.

1. Keep redacted content on LLM spans so Tempo can display it.
2. Emit separate Loki log records whose log body is the already-redacted content and whose attributes identify the event (`llm.prompt.captured`, `llm.response.captured`, `llm.thinking.captured`), session, agent lineage, trace ID, span ID, content kind, and truncation metadata.
3. Update the bundled Collector so its traces pipeline no longer strips the redacted LLM content attributes. Keep or adjust log attribute dropping deliberately so intentional content logs are not silently removed.
4. Update dashboards to show the content-capture log bodies in Grafana while clearly labeling them as redacted, opt-in content.
5. Update tests and docs to lock in privacy defaults and the new opt-in visibility behavior.

## Relevant Files

- `src/pi/handler-internals.ts` - Current extracted helper path for optional prompt/response/thinking capture and redaction.
- `src/pi/handlers.ts` - Current handler implementation still contains related log/span emission paths; ensure the active implementation is updated without duplicating behavior.
- `src/semconv/attributes.ts` - Add or reuse attributes for content kind, trace/span correlation, and truncation metadata.
- `src/semconv/metrics.ts` - Existing content event names live here; add new event names only if existing names cannot serve both audit and content logs.
- `src/privacy/redact.ts` and `src/privacy/truncate.ts` - Existing redaction/truncation behavior must remain the only path for emitted content.
- `observability-stack/config/otel/otel-collector.yaml` - Remove redacted LLM content stripping from the Tempo path and ensure Loki receives content logs.
- `dashboards/observme-logs-llm.json` - Add/update panels so captured redacted content appears in Grafana.
- `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` - Document any new attributes and log behavior.
- `ObservMe-Production-Docs/05-otel-pipeline-and-collector.md` - Keep the documented Collector reference aligned with the shipped local Collector config.
- `ObservMe-Production-Docs/06-security-privacy-redaction.md` - Document opt-in content export to both Tempo and Loki.
- `ObservMe-Production-Docs/09-dashboards-alerts-slos.md` - Document the updated dashboard behavior.
- `ObservMe-Production-Docs/12-configuration-reference.md` - Clarify which env/config settings are required for content visibility.
- `README.md` - Add concise user-facing troubleshooting/configuration notes.
- `CHANGELOG.md` - Record the user-visible behavior change.
- `test/handler-internals.test.ts`, `test/pi-handlers.test.mjs`, `test/event-mapping.test.ts` - Assert redacted content is exported only when capture is enabled.
- `test/examples.test.mjs`, `test/dashboards.test.mjs` - Update Collector/dashboard assertions.
- `test/integration/grafana-stack.test.mjs` - Add or extend backend assertions for Tempo and Loki content visibility.

## Implementation Phases

### Phase 1: Foundation

- Confirm the active handler path for LLM content capture to avoid changing stale duplicate code only.
- Define the content log shape and attribute names.
- Preserve the existing redaction/truncation behavior and capture gates.

### Phase 2: Core Implementation

- Refactor the LLM content capture helper to return the redacted value plus truncation metadata.
- Set redacted content on spans as today.
- Emit correlated Loki log records with redacted content as the log body.
- Update Collector pipelines so Tempo keeps redacted content attributes.

### Phase 3: Integration & Polish

- Update Grafana dashboards for prompt/response/thinking content logs.
- Update tests, production docs, README, and CHANGELOG.
- Validate locally with unit tests and, where available, the Grafana stack integration test.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom. Mark each item with `[x]` only after its acceptance criteria are met.

### 1. Verify Current Active Capture Flow

- [x] Trace which file is currently used for LLM content capture (`src/pi/handler-internals.ts` vs `src/pi/handlers.ts`).
- [x] Confirm prompt capture starts from `before_provider_request` and response/thinking capture starts from assistant `message_end`.
- [x] Confirm the existing env vars are loaded into `config.capture.*` and `config.privacy.*`.
- [x] Identify all existing tests that assert content capture behavior.

#### Acceptance criteria

- The implementation target files are known.
- No duplicate content logs will be emitted from both old and extracted helper paths.

### 2. Define Redacted Content Log Shape

- [x] Reuse existing event names where possible:
  - `llm.prompt.captured`
  - `llm.response.captured`
  - `llm.thinking.captured`
- [x] Add content metadata attributes if needed, for example:
  - `pi.llm.content.kind`: `prompt | response | thinking`
  - `observme.truncated`
  - `observme.original_length`
  - `trace_id`
  - `span_id`
- [x] Ensure log records include existing safe lineage attributes from `buildLineageMetricSafeLogAttributes(session)`.
- [x] Decide whether the log body should be only the redacted content or a short prefix plus content. Prefer only redacted content so Grafana Logs panels show the chat text directly.

#### Acceptance criteria

- The log schema is documented in the spec implementation notes or semantic-conventions doc.
- The schema supports Grafana filtering by `event_name` and session/agent labels without using raw content as a query input.

### 3. Refactor Redacted LLM Content Emission

- [x] Change the redaction helper so prompt/response/thinking capture can both set a span attribute and emit a content log from the same redacted result.
- [x] Avoid running the redaction pipeline twice for the same content.
- [x] Keep existing max length settings:
  - `limits.maxPromptChars`
  - `limits.maxResponseChars`
- [x] Include truncation metadata on both span attributes and content log attributes when truncation occurs.
- [x] Increment `redactionFailures` and skip both span/log content when redaction drops the value.

#### Acceptance criteria

- Prompt, response, and thinking content each have one redaction pass and at most one content log record per captured value.
- Content is never emitted when the corresponding capture flag is disabled.
- Redaction failure behavior remains fail-closed for content emission.

### 4. Emit Correlated Loki Content Logs

- [x] Add a helper such as `emitCapturedContentLog(...)` that emits `logger.emit({ body: redactedContent, attributes: ... })`.
- [x] Include `event.name`, `event.category`, `pi.session.id`, agent lineage, content kind, trace ID, and span ID when available.
- [x] Use category such as `llm_content` or `content_capture` to distinguish content logs from lifecycle audit logs.
- [x] Keep the existing lifecycle/audit logs or intentionally replace them only if tests and dashboards are updated accordingly.

#### Acceptance criteria

- Loki receives visible redacted content in the log line/body when capture is enabled.
- Existing lifecycle dashboards can still count `llm.*.captured` events.
- `/obs logs` remains safe: it should not require raw prompt text as input and should not accidentally expose content unless explicitly intended by the command design.

### 5. Update Collector Pipeline for Tempo and Loki

- [x] Update `observability-stack/config/otel/otel-collector.yaml` so the traces pipeline no longer applies a processor that deletes:
  - `pi.llm.prompt.redacted`
  - `pi.llm.response.redacted`
  - `pi.llm.thinking.redacted`
- [x] Decide whether to keep content attribute dropping in the logs pipeline. If content is emitted as the log body, the logs processor can keep dropping accidental content attributes while allowing intentional redacted log bodies.
- [x] Add comments explaining that content appears only when ObservMe capture flags emit it.
- [x] Update the matching production docs Collector reference so tests comparing docs and config keep passing.

#### Acceptance criteria

- New LLM request spans in Tempo include redacted prompt/response/thinking attributes when enabled.
- Loki content logs are not stripped by the Collector.
- Default-disabled content remains absent because ObservMe does not emit it.

### 6. Update Grafana Dashboard Panels

- [x] Update `dashboards/observme-logs-llm.json` description: redacted content is now intentionally visible when capture is enabled.
- [x] Add or update panels for:
  - Captured prompts: `{service_name="observme-pi-extension", event_name="llm.prompt.captured"}`
  - Captured responses: `{service_name="observme-pi-extension", event_name="llm.response.captured"}`
  - Captured thinking: `{service_name="observme-pi-extension", event_name="llm.thinking.captured"}`
- [x] Ensure panels show log line/body and labels/details.
- [x] Keep existing size/token panels unchanged.

#### Acceptance criteria

- Grafana has obvious panels where users can see the redacted chat input/output.
- Dashboard selectors use only provisioned Loki labels.
- Dashboard JSON passes existing dashboard validation tests.

### 7. Update Tests

- [x] Add/adjust unit tests for prompt capture logs:
  - no content by default
  - redacted content in span + log when enabled
  - secrets are redacted from both span and log
  - truncation metadata appears when content exceeds limits
- [x] Add/adjust unit tests for response and thinking logs with the same privacy expectations.
- [x] Update Collector config tests that currently expect `attributes/drop_content_attributes` in traces.
- [x] Update dashboard tests if panel count, descriptions, or queries change.
- [x] Extend Grafana-stack integration tests to query:
  - Tempo trace attributes for redacted content
  - Loki logs for `llm.prompt.captured` and `llm.response.captured` lines

#### Acceptance criteria

- Tests prove content is visible only when explicitly enabled.
- Tests prove raw secret fixtures are not exported when redaction is enabled.
- Integration coverage proves both Tempo and Loki visibility against the bundled stack.

### 8. Update Documentation and Changelog

- [x] Update `README.md` with a short “Show LLM chat content in Grafana” section.
- [x] Update `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` for new/changed log attributes.
- [x] Update `ObservMe-Production-Docs/05-otel-pipeline-and-collector.md` for the Collector pipeline change.
- [x] Update `ObservMe-Production-Docs/06-security-privacy-redaction.md` to explain redacted content export to Tempo and Loki.
- [x] Update `ObservMe-Production-Docs/09-dashboards-alerts-slos.md` for the dashboard panels.
- [x] Update `ObservMe-Production-Docs/12-configuration-reference.md` with the required env vars and safety warning.
- [x] Update `CHANGELOG.md`.

#### Acceptance criteria

- User docs explain that old data cannot be recovered after Collector drops it; users must generate new LLM events after the change.
- Docs clearly state that content visibility requires explicit capture flags and redaction/unsafe-capture acknowledgement.
- `CHANGELOG.md` includes the behavior change.

### 9. Validate End-to-End

- [x] Run unit/static validation.
- [x] Restart the local observability stack after Collector/dashboard changes.
- [x] Start a new Pi session with capture env vars enabled.
- [x] Send a prompt with a benign unique marker and a fake secret fixture.
- [x] Confirm Grafana Tempo shows redacted prompt/response/thinking span attributes.
- [x] Confirm Grafana Loki dashboard panels show redacted prompt/response/thinking log bodies.
- [x] Confirm fake secret fixture is redacted everywhere.

#### Acceptance criteria

- Both Tempo and Loki display redacted LLM chat content for new events.
- No raw secret fixture appears in exported telemetry.
- All validation commands pass or backend-dependent skips are clearly documented.

## Testing Strategy

Use layered testing:

1. Unit tests for redaction/content emission helpers.
2. Handler/event mapping tests for capture flag behavior.
3. Dashboard and Collector config tests for static correctness.
4. Grafana-stack integration tests for actual Tempo/Loki visibility.
5. Manual smoke validation with a running Pi session and local Grafana.

Important edge cases:

- Capture flags disabled: no content span attributes and no content log body.
- Redaction enabled: secrets and paths are redacted before span/log export.
- Redaction failure/drop: no content emitted, redaction failure metric increments.
- Truncation: span/log have truncated content plus metadata.
- Active session: child LLM spans/logs may appear before root session span ends.

## Acceptance Criteria

- With capture enabled, Grafana Tempo displays `pi.llm.prompt.redacted`, `pi.llm.response.redacted`, and `pi.llm.thinking.redacted` on new LLM spans when those values exist.
- With capture enabled, Grafana Loki displays redacted prompt/response/thinking content in log bodies for `llm.*.captured` events.
- With capture disabled, no prompt/response/thinking content is exported to traces or logs.
- The bundled LLM logs dashboard has panels that surface the redacted content logs.
- The Collector no longer strips intentional redacted LLM content from Tempo traces.
- Raw secrets from test fixtures are not exported when redaction is enabled.
- README, production docs, and CHANGELOG are updated.

## Validation Commands

Execute these commands to validate the task is complete:

- `npm run typecheck` - TypeScript validation.
- `npm run typecheck:test` - Test TypeScript validation.
- `npm run lint:eslint` - ESLint validation.
- `npm run format:check` - Formatting validation.
- `npm run test` - Unit and static test suite.
- `npm run test:integration:grafana-stack` - Validate Tempo/Loki/Prometheus/Grafana behavior against the bundled stack.
- `npm run validate` - Full repository validation if time/resources allow.

## Notes

- Old telemetry cannot show dropped content. After changing the Collector, generate new LLM events.
- Do not make content capture default-on.
- Do not use raw content in Loki/Tempo/Grafana query strings.
- Do not remove redaction. If `OBSERVME_ALLOW_UNSAFE_CAPTURE=true` is used, the extension must still surface the existing unsafe-capture warning.
- Keep task changes small and mark checklist items complete only after their acceptance criteria are met.
