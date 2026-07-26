# Fix LLM Conversations visibility and agent-name filtering

### 1. Restore reliable conversation visibility before reintroducing agent-name filtering

- [x] Reproduce and fix the LLM Conversations regression end to end so unfiltered prompt, response, and thinking records remain visible, while agent-name filtering works without unsupported Grafana/Loki variable syntax or broad metadata scans.

#### Why

The LLM Conversations dashboard stopped showing records after agent-name filtering was added. Structural dashboard tests passed, but they did not validate the rendered dashboard against the pinned Grafana 11.1 and Loki 3.0 stack.

Observed investigation evidence:

- Grafana 11.1's Loki datasource supports label-name and label-value template variables, but not the attempted `query_result(...)` variable.
- `pi_agent_display_name` is intentionally retained as Loki structured metadata rather than an indexed label.
- Adding `pi_agent_display_name=~".*"` to every content query introduced an unnecessary metadata scan and could time out over broader ranges.
- The local stack contained historical conversation records that were returned by the pre-change query over a sufficiently wide range, while the active Grafana range contained no recent LLM telemetry.
- Rolling the dashboard JSON back alone did not establish why current LLM lifecycle/content events were no longer arriving, so producer/export health and dashboard behavior must be tested separately.

The fix must distinguish these failure classes instead of treating every empty panel as a dashboard-query defect:

1. no recent LLM events were emitted or exported;
2. content capture was disabled or rejected;
3. the selected time range excludes existing records;
4. dashboard variables produced an invalid or over-restrictive query;
5. Loki/Grafana timed out while scanning structured metadata.

#### How

1. Build a deterministic exporter-enabled Grafana-stack fixture that emits fresh, redacted opt-in prompt, response, and thinking records for:
   - one named agent;
   - a second named agent;
   - one record without `pi_agent_display_name` for backward compatibility.
2. Verify the fixture reaches the Collector, Loki, and Grafana datasource before evaluating dashboard panels. Capture safe event names, timestamps, and correlation IDs only; never print captured bodies or credentials in diagnostics.
3. Reproduce the dashboard with all filters at their defaults and with a URL-preserved time range that includes the fixture. Record the exact interpolated LogQL and Grafana/Loki response status.
4. Restore the canonical conversation panels first. Their default/unfiltered state must use the existing indexed context labels and must show named and unnamed records without requiring an agent-name metadata matcher.
5. Design agent-name filtering around the capabilities of the pinned Grafana/Loki versions. Do not use `query_result(...)` as a Loki template variable. Do not promote display names to Prometheus labels. If Loki label promotion is considered, document and test the explicit log-stream cardinality decision before implementation; otherwise use a bounded name-to-indexed-agent-ID interaction that has an end-to-end Grafana test.
6. Keep `pi_agent_id` as the exact correlation key because friendly names may be duplicated. Selecting a friendly name must resolve to the intended indexed agent ID or IDs without placing raw content in URLs or queries.
7. Ensure the All/unset agent-name state removes the name restriction rather than evaluating a structured-metadata wildcard over every record. Historical records without a display name must remain visible in this state.
8. Add bounded diagnostics or visible empty-state guidance that distinguishes “no telemetry in range” from capture-disabled, query-error, and datasource-timeout states where Grafana supports it.
9. Update dashboard contract tests and the Docker-backed Grafana-stack integration test so the regression cannot pass through JSON-only assertions again.
10. Update the dashboard reference documentation and `CHANGELOG.md` with the final supported interaction and any Collector requirements.

#### Where

- `dashboards/observme-llm-conversations.json`
- `test/dashboards.test.mjs`
- `test/integration/grafana-stack.test.mjs`
- `test/integration/fixtures/` or the existing Grafana-stack telemetry fixture location
- `observability-stack/config/otel/otel-collector.yaml` only if the accepted design requires a Collector change
- `docs/reference/09-dashboards-alerts-slos.md`
- `docs/reference/11-deployment-runbooks.md` if troubleshooting guidance changes
- `CHANGELOG.md`

#### Acceptance criteria

- The pinned local Grafana 11.1/Loki 3.0 stack displays fresh redacted prompt, response, and thinking fixture records in the canonical conversation timeline with every dashboard filter set to All/default.
- The unfiltered dashboard displays records both with and without `pi_agent_display_name`.
- Agent-name filtering is usable in the rendered Grafana dashboard and returns only the intended agent's records by resolving through indexed technical correlation keys or another explicitly approved, cardinality-safe design.
- Duplicate friendly names do not silently merge unrelated agents; the UI exposes enough technical identity to disambiguate them.
- The All/unset name state does not add `pi_agent_display_name=~".*"` or an equivalent broad structured-metadata scan to every conversation panel.
- No Loki template variable uses unsupported `query_result(...)` syntax for the pinned Grafana datasource.
- A selected time range containing the fixture succeeds without datasource timeout, and a range excluding it produces a documented empty state rather than a query error.
- The integration test verifies actual Grafana datasource responses for the timeline, prompts, responses, thinking, and agent-name filtering; JSON structure checks alone are insufficient.
- Tests verify capture-disabled and no-recent-telemetry cases separately from dashboard-query failures.
- Raw prompt, response, and thinking bodies never appear in variable queries, dashboard URLs, test failure messages, or Prometheus labels.
- `pi_agent_display_name` and agent IDs remain absent from Prometheus metric labels.
- Documentation states the supported filtering behavior, duplicate-name semantics, time-range expectations, and the `/obs status` / `/obs health` checks for missing current telemetry.
- `CHANGELOG.md` describes the restored visibility and final filtering behavior.
- `npm run format:check`, `node --test test/dashboards.test.mjs`, and `npm run test:integration:grafana-stack` pass.
