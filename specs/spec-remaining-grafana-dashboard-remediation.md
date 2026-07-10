# Plan: Remediate the Remaining Grafana Dashboards

## Task Description

Audit and improve every remaining Grafana dashboard JSON file under `dashboards/` using the same operational standard applied to `observme-errors.json`, `observme-llm-conversations.json`, and `observme-cost.json`.

The work is an **enhancement/fix** with **complex** scope. Complete one dashboard at a time, validate it before moving on, and mark that task with `x` only when all acceptance criteria pass.

This plan covers the 11 remaining dashboard JSON files. It excludes:

- `dashboards/observme-errors.json`
- `dashboards/observme-llm-conversations.json`
- `dashboards/observme-cost.json`
- `dashboards/observme-alerts.yaml`
- `dashboards/observme-slos.yaml`
- TypeScript source, tests, documentation, and configuration files

The YAML alert and SLO files are read-only references for threshold and formula alignment.

## Objective

Produce a consistent, usable, and backend-valid Grafana dashboard suite where:

- PromQL and LogQL queries parse and execute successfully, not merely pass static string tests.
- Missing series and healthy idle periods are represented intentionally.
- Ratios preserve label matching and do not disappear when the numerator is absent.
- Scalar Grafana macros such as `$__range_s` are never passed to vector-only PromQL functions such as `clamp_min()` or `clamp_max()`.
- Selected-range totals use instant queries; trends use range queries with appropriate windows.
- Thresholds match documented alert/SLO references and clearly identify tunable assumptions.
- Loki tables expose useful fields and working Tempo links instead of only timestamps or raw lines.
- High-cardinality identifiers remain limited to Loki/Tempo filters and links.
- Navigation, layout, privacy guidance, zero-state descriptions, schema versions, and panel versions are consistent.

## Problem Statement

The remaining dashboards were created at different stages and vary in query safety, layout, drill-down behavior, zero-state handling, schema version, and operator guidance. Static dashboard tests catch shape and naming regressions but do not prove that every query is accepted by Prometheus, Loki, Tempo, or Grafana. Recent remediation found runtime-only failures such as vector functions receiving scalar macros and Loki tables rendering only timestamps.

A dashboard-by-dashboard remediation is required so each file is reviewed against the telemetry actually emitted by ObservMe and validated through the real observability backend where available.

## Solution Approach

Use a repeatable audit for each dashboard:

1. Read the dashboard, semantic conventions, relevant alert/SLO definitions, Collector label promotion, and existing tests.
2. Inventory every panel, target, annotation, variable, link, panel ID, title, and grid position.
3. Check query semantics:
   - PromQL scalar versus vector types.
   - Label matching in binary expressions.
   - Counter `increase()`/`rate()` windows.
   - Histogram aggregation labels and `le` preservation.
   - Instant versus range query mode.
   - Zero fallbacks and their operational meaning.
   - LogQL selectors, parsers, line formatting, and promoted labels.
4. Improve the dashboard hierarchy with rows, compact health/summary panels, bounded detail panels, and clear drill-down links without duplicating domain dashboards.
5. Align thresholds and explanatory text with `observme-alerts.yaml`, `observme-slos.yaml`, and production documentation.
6. Increment the dashboard version while preserving its UID.
7. Validate JSON, formatting, panel geometry, static dashboard tests, and all backend queries before marking the task complete.

Do not copy formulas blindly from another dashboard. Confirm each metric’s emitted labels and denominator first.

## Relevant Files

### Dashboards to update

- `dashboards/observme-models.json` — Provider/model traffic, reliability, latency, stop reasons, and efficiency.
- `dashboards/observme-tools.json` — Tool volume, failures, latency, bash outcomes, result sizes, and top offenders.
- `dashboards/observme-latency.json` — Stage quantiles, volume companions, and slow-operation drill-downs.
- `dashboards/observme-agents.json` — Agent/subagent health, ratios, orchestration thresholds, top offenders, and Loki handoffs.
- `dashboards/observme-agent-node-graphs.json` — Aggregate node/edge frame visualizations and health coloring.
- `dashboards/observme-branches-compactions.json` — Branch estimates, compactions, model/thinking changes, and Loki detail rows.
- `dashboards/observme-export-health.json` — Export liveness, local failures, SLO context, and failure logs.
- `dashboards/observme-slo-health.json` — SLO scorecards, burn rates, and alert threshold references.
- `dashboards/observme-logs-llm.json` — LLM size/token trends and privacy-safe lifecycle log drill-downs.
- `dashboards/observme-trace-journey.json` — End-to-end execution summaries, Loki events, Tempo traces, and context filters.
- `dashboards/observme-overview.json` — Final landing-page consistency and navigation pass after domain dashboards are complete.

### Read-only references

- `dashboards/observme-errors.json` — Remediated error-dashboard patterns and zero-safe failure handling.
- `dashboards/observme-llm-conversations.json` — Remediated privacy guidance, cascading Loki filters, deterministic field extraction, and trace links.
- `dashboards/observme-cost.json` — Remediated selected-range totals, budget semantics, instant-query usage, and attribution patterns.
- `dashboards/observme-alerts.yaml` — Canonical alert expressions and default thresholds.
- `dashboards/observme-slos.yaml` — Canonical SLO formulas and objectives.
- `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` — Metric names, event names, units, and bounded labels.
- `ObservMe-Production-Docs/09-dashboards-alerts-slos.md` — Dashboard responsibilities, zero-state interpretation, and drill-down guidance.
- `observability-stack/config/otel/otel-collector.yaml` — Loki label promotion and datasource assumptions.
- `observability-stack/config/grafana/provisioning/datasources/datasources.yaml` — Provisioned datasource UIDs and Tempo/Loki relationships.
- `test/dashboards.test.mjs` — Existing dashboard contracts and regression coverage.
- `test/integration/grafana-stack.test.mjs` — Live-stack validation behavior and limitations.

## Implementation Phases

### Phase 1: Domain Dashboards

Remediate Models, Tools, Latency, Agents, Agent Node Graphs, and Branches/Compactions. Fix query semantics and top-offender/detail presentation before touching aggregate landing pages.

### Phase 2: Reliability and Drill-down Dashboards

Remediate Export Health, SLO Health, Logs and LLM I/O, and Trace Journey. Ensure alert/SLO alignment, privacy boundaries, context propagation, Loki field extraction, and Tempo links.

### Phase 3: Landing Page and Suite Validation

Update Overview after the destination dashboards stabilize, then run cross-dashboard navigation, geometry, static, and live-backend validation.

## Step by Step Tasks

IMPORTANT: Execute every task in order. Change only the dashboard named by the current task. Mark its checkbox with `x` only after every acceptance criterion for that task passes.

### 1. Remediate the Models dashboard

- [ ] Audit and update `observme-models.json` for reliable provider/model comparison and drill-down behavior.

#### Why

Provider/model ratios can disappear when failure series are absent, sparse models can distort latency/efficiency panels, and the dashboard currently lacks the navigation and hierarchy added to the remediated dashboards.

#### How

- Add clear rows for traffic/reliability, latency, stop reasons, and efficiency where they improve scanning.
- Zero-fill provider/model failure numerators from matching request series without losing labels.
- Preserve matching `(provider, model)` labels on every binary expression.
- Keep selected-range stop-reason totals as bounded instant queries.
- Verify cost-per-request uses LLM request volume and overall cost-per-turn remains explicitly aggregate-only.
- Add volume context and top limits where sparse or numerous models would make panels misleading.
- Add links to Cost, Latency, Errors, LLM lifecycle logs, LLM Conversations, and Trace Journey as appropriate.
- Align descriptions and thresholds with documented error and cost guidance.

#### Where

- `dashboards/observme-models.json`

#### Acceptance criteria

- Every ratio renders zero for an active denominator with no failures instead of disappearing.
- No model-level panel divides by a global turn counter.
- Stop-reason totals use `$__range`, `instant: true`, and `range: false`.
- All provider/model binary expressions have valid PromQL label matching.
- Panels have unique IDs/titles, no overlaps, valid datasource UIDs, and working links.
- Every target executes successfully against the backend for active and idle ranges.
- Dashboard version is incremented and UID is unchanged.

### 2. Remediate the Tools dashboard

- [ ] Audit and update `observme-tools.json` for failure, latency, bash, size, and top-offender workflows.

#### Why

Tool dashboards need denominator-safe failure ratios, bounded offender views, correct selected-range query modes, and explicit character semantics for `*_size_chars` metrics.

#### How

- Organize traffic, reliability, latency/size, and top-offender panels into readable sections.
- Zero-fill tool failure numerators from matching call series while preserving `tool_name`.
- Apply top limits to high-count tool views without hiding the aggregate zero state.
- Use instant queries for selected-range bash outcomes and top tables; use range queries for trends.
- Keep tool result sizes in character/count units, never bytes.
- Pair percentile panels with volume and explain sparse percentile risk.
- Add links to Latency, Errors, Trace Journey, and filtered tool failure logs.

#### Where

- `dashboards/observme-tools.json`

#### Acceptance criteria

- Tool failure ratios remain visible at zero for tools with calls but no failures.
- Selected-range bar gauges/tables are instant queries.
- Percentiles preserve `le` and bounded tool labels.
- `observme_tool_result_size_chars` uses a character/count unit and description.
- Top-offender panels include volume and are bounded.
- All queries execute without parser or label-matching errors.
- Dashboard version is incremented and UID is unchanged.

### 3. Remediate the Latency dashboard

- [ ] Audit and update `observme-latency.json` for stage comparison, volume context, and representative drill-downs.

#### Why

Latency quantiles are easy to misread without operation volume, and histogram queries fail or become misleading when aggregation labels, sparse series, or query modes are wrong.

#### How

- Create a clear hierarchy for summary quantiles, stage comparisons, top offenders, and detailed trends.
- Verify every histogram quantile preserves `le` plus only the bounded grouping labels emitted by that metric.
- Keep p50/p95/p99 tables paired with selected-range volume.
- Use instant queries for selected-range top tables and range queries for trends.
- Add zero/idle descriptions without converting genuine missing instrumentation into false healthy values.
- Bound provider/model, tool, and agent-role offender tables.
- Preserve links to Models, Tools, Agents, Errors, and Trace Journey.

#### Where

- `dashboards/observme-latency.json`

#### Acceptance criteria

- Stage quantile views contain p50, p95, and p99 plus volume context.
- Histogram expressions use valid bucket names and retain `le`.
- Selected-range tables are instant queries and trends are range queries.
- Sparse/no-data behavior is documented and operationally accurate.
- Every target executes successfully in Prometheus.
- Dashboard version is incremented and UID is unchanged.

### 4. Remediate the Agents and Subagents dashboard

- [ ] Audit and update `observme-agents.json` for orchestration health, ratios, top offenders, and lineage drill-downs.

#### Why

This is the largest domain dashboard and combines many ratios, histograms, thresholds, and high-cardinality Loki details. It needs strong hierarchy and careful separation between aggregate Prometheus labels and per-execution Loki fields.

#### How

- Group panels into health ratios, activity/latency, tree shape, top offenders, and lineage logs.
- Verify spawn, orphan, propagation, and recovery ratios use the correct denominators and zero-fill semantics.
- Align depth, fan-out, and active-agent threshold references with alert definitions.
- Convert selected-range offender tables to bounded instant queries with volume context.
- Keep session/workflow/agent/trace identifiers out of Prometheus expressions.
- Rework `Parent/child handoffs with trace links` if necessary so event, parent, child, run, trace, and span fields render deterministically rather than showing only timestamps.
- Preserve working Tempo links and Trace Journey filter propagation.

#### Where

- `dashboards/observme-agents.json`

#### Acceptance criteria

- All ratio denominators match emitted metric semantics and labels.
- No forbidden high-cardinality identifier appears in PromQL or metric legends.
- Alert-aligned tree depth and fan-out references remain visible.
- Top tables are bounded, selected-range instant queries.
- The handoff table displays useful context columns and clickable Tempo traces with content/raw lines hidden where appropriate.
- Every PromQL and LogQL target executes successfully.
- Dashboard version is incremented and UID is unchanged.

### 5. Remediate the Agent Node Graphs dashboard

- [ ] Audit and update `observme-agent-node-graphs.json` while preserving Grafana Node Graph frame contracts.

#### Why

Node Graph panels require exact `nodes` and `edges` frames. Cosmetic refactors or query fallbacks can easily break IDs, source/target relationships, stats, or health coloring.

#### How

- Preserve exactly one `nodes` and one `edges` target per node graph.
- Verify targets use table format, instant queries, and stable bounded aggregate IDs.
- Confirm node fields include `id`, `title`, `mainStat`, `secondaryStat`, and health color where relevant.
- Confirm edge fields include `source`, `target`, and meaningful aggregate statistics.
- Explain that the graphs show aggregate topology, not a single trace tree.
- Add concise navigation and healthy-idle guidance without introducing high-cardinality labels.

#### Where

- `dashboards/observme-agent-node-graphs.json`

#### Acceptance criteria

- Both panels render valid Node Graph frames with no missing node references.
- Health-risk nodes/edges retain red status context.
- All queries are bounded instant table queries.
- No session, workflow, agent, trace, or span IDs are used as metric labels.
- Links to Agents and Trace Journey preserve the time range.
- Dashboard version is incremented and UID is unchanged.

### 6. Remediate the Branches and Compactions dashboard

- [ ] Audit and update `observme-branches-compactions.json` for branch estimates, compaction pressure, change context, and Loki details.

#### Why

Branch counts can be sparse estimates, compaction histograms need correct units and quantiles, and Loki detail tables need deterministic field extraction and clear empty-state behavior.

#### How

- Separate branch/compaction summaries, trends, model/thinking changes, and log details.
- Clearly label estimates that cannot be exact because metric labels are intentionally bounded.
- Verify compaction histogram units, bucket names, and `le` aggregation.
- Use selected-range instant queries for totals and range queries for trends.
- Make branch and compaction tables expose useful fields, hide raw/unneeded line data, and sort intentionally.
- Add links to Cost, Models, Latency, Logs and LLM I/O, and Trace Journey.

#### Where

- `dashboards/observme-branches-compactions.json`

#### Acceptance criteria

- Estimates are explicitly described as estimates and do not imply unavailable per-session attribution.
- Compaction quantiles execute with valid histogram grouping and units.
- Model/thinking change context remains visible and links to affected dashboards.
- Loki tables show parsed context fields and documented healthy empty states.
- Every target executes successfully.
- Dashboard version is incremented and UID is unchanged.

### 7. Remediate the Export Health dashboard

- [ ] Audit and update `observme-export-health.json` without weakening its existing zero-state, SLO, and alert contracts.

#### Why

Export Health is already mature but combines liveness, healthy idle behavior, failure-only signals, SLO summaries, and Loki tables. Changes must improve usability without turning missing instrumentation into false green health.

#### How

- Preserve visible liveness, drop, export, redaction, handler latency, and SLO signals.
- Recheck composite health formulas for vector/scalar correctness and bounded output.
- Keep zero fallbacks for documented failure counters and explain healthy idle versus absent telemetry.
- Align thresholds and text with alert/SLO YAML.
- Improve signal hierarchy and navigation only where it reduces scanning.
- Make failure log tables expose useful fields and trace links rather than only timestamps/raw lines.
- Preserve the explicit statement that empty failure tables can be healthy.

#### Where

- `dashboards/observme-export-health.json`

#### Acceptance criteria

- Existing export-health dashboard tests continue to pass.
- Composite health distinguishes idle/no-failure from active failure states.
- No scalar macro is passed to a vector-only PromQL function.
- All failure counters have intentional zero-state handling.
- Failure log tables render context columns and working links where trace IDs exist.
- Every query executes successfully in the live backend.
- Dashboard version is incremented and UID is unchanged.

### 8. Remediate the SLO Health dashboard

- [ ] Audit and update `observme-slo-health.json` for correct scorecards, burn rates, and threshold guidance.

#### Why

SLO dashboards can look healthy while queries are absent or malformed. Burn-rate windows and scorecards must match the canonical SLO/alert definitions and clearly document idle behavior.

#### How

- Preserve the required 30-day scorecards and 1h/30d burn-rate views.
- Compare every formula with `observme-slos.yaml` and every threshold reference with `observme-alerts.yaml`.
- Audit scalar/vector types, denominator guards, clamp bounds, and no-workload semantics.
- Distinguish production telemetry SLOs from CI/test-only redaction guidance.
- Keep links to Overview, Export Health, Agents, Trace Journey, and Errors.
- Improve layout and descriptions without duplicating full domain dashboards.

#### Where

- `dashboards/observme-slo-health.json`

#### Acceptance criteria

- Required SLO panel names, metrics, units, and windows remain intact.
- Burn-rate formulas match canonical objectives and execute successfully.
- Idle/no-workload behavior is explicit and cannot silently produce a false healthy state.
- Alert reference values match YAML defaults and are marked tunable where appropriate.
- Dashboard version is incremented and UID is unchanged.

### 9. Remediate the Logs and LLM I/O dashboard

- [ ] Audit and update `observme-logs-llm.json` for privacy-safe lifecycle logs, token/size trends, and cascading filters.

#### Why

This dashboard bridges aggregate LLM telemetry and per-execution logs. It must keep captured content in the canonical Conversations dashboard, avoid raw-content queries, and provide filters that narrow consistently.

#### How

- Update the dashboard to the current schema version.
- Keep prompt/response sizes in characters and token trends as interval deltas.
- Preserve the canonical LLM Conversations routing panel and privacy warning.
- Ensure broad session logs exclude `event_category="llm_content"`.
- Cascade session, workflow, agent, run, provider, model, and content-kind variables consistently.
- Add bounded log limits, intentional ordering, useful log details, and time-preserving links.
- Confirm no raw prompt, response, thinking, command, or path content appears in query strings.

#### Where

- `dashboards/observme-logs-llm.json`

#### Acceptance criteria

- Schema version is current and dashboard version is incremented.
- All required filter variables remain defined and usable.
- Size panels use character units; token trends use `$__interval`.
- Non-content log panels exclude LLM content bodies.
- Links to Conversations and Trace Journey preserve supported filters.
- Every LogQL and PromQL target executes successfully.
- UID is unchanged.

### 10. Remediate the Trace Journey dashboard

- [ ] Audit and update `observme-trace-journey.json` for reliable summary stats, journey events, Loki tables, and Tempo traces.

#### Why

Trace Journey combines all three backends and is the primary per-execution drill-down. It must preserve filter context, valid Tempo target shapes, chronological logs, and aggregate/per-trace boundaries.

#### How

- Update the dashboard to the current schema version and organize summary, flow, latency, lineage, logs, and traces into clear sections.
- Recheck summary totals/ratios for selected-range instant semantics and healthy zero states.
- Verify histogram and handoff expressions use emitted bounded labels.
- Preserve session/workflow/agent/run variables only in Loki/Tempo queries and links.
- Ensure `Execution journey events` and `Ordered journey log` remain logs panels with intentional ordering.
- Make handoff and trace tables expose useful fields and working Tempo links; use deterministic extraction when labels-to-fields alone is insufficient.
- Validate Tempo queries and data links through Grafana, not only JSON tests.
- Preserve links to filtered LLM Conversations, Agents, and Agent Node Graphs.

#### Where

- `dashboards/observme-trace-journey.json`

#### Acceptance criteria

- Required stats, journey flow, latency, tree-shape, handoff, log, and Tempo panels remain present.
- Filter links preserve session, workflow, agent, and run variables where supported.
- Tempo targets use valid queries and provisioned datasource UID `tempo`.
- Loki tables do not degrade to timestamp-only output.
- High-cardinality IDs do not enter Prometheus queries.
- Every PromQL, LogQL, and TraceQL target executes successfully.
- Dashboard version is incremented and UID is unchanged.

### 11. Remediate the Overview dashboard

- [ ] Audit and update `observme-overview.json` as the final landing-page pass.

#### Why

Overview should summarize health and route operators to completed domain dashboards. Updating it last prevents stale navigation and avoids duplicating detail that belongs elsewhere.

#### How

- Preserve the required row order: Health, Workload, Cost, Latency, Agent lineage, Links.
- Keep health chips compact, zero-safe, and linked to their canonical dashboards.
- Audit all formulas for scalar/vector correctness; specifically remove any use of vector-only `clamp_*` functions around scalar macros such as `$__range_s`.
- Keep workload stats as rates/gauges with accurate idle and restart caveats.
- Keep cost, latency, and agent summaries concise and move detailed analysis to domain links.
- Verify navigation includes every canonical dashboard with the current time range.
- Align thresholds with alert/SLO defaults and identify tunable assumptions.

#### Where

- `dashboards/observme-overview.json`

#### Acceptance criteria

- Existing Overview row order and required health-chip tests pass.
- No scalar macro is passed to `clamp_min()` or `clamp_max()`.
- All summary queries execute successfully for active and idle ranges.
- Navigation reaches Cost, Models, Latency, Tools, Agents, Agent Node Graphs where appropriate, Trace Journey, Errors, Export Health, SLO Health, Logs and LLM I/O, and LLM Conversations.
- Overview remains a landing page rather than duplicating domain detail.
- Dashboard version is incremented and UID is unchanged.

### 12. Validate the complete dashboard suite

- [ ] Run static, geometry, navigation, and live-backend validation across all dashboard JSON files.

#### Why

Static JSON and repository tests do not detect every PromQL type error, LogQL formatting failure, Tempo query issue, or Grafana transformation problem.

#### How

- Parse every dashboard JSON file and check formatting/whitespace.
- Check unique panel IDs/titles and verify no grid overlaps or positions beyond the 24-column grid.
- Run dashboard unit tests and the repository format check.
- Provision the Grafana stack when Docker is available.
- Execute every Prometheus, Loki, and Tempo panel/annotation query with representative macro values and filters.
- Verify active-data and idle/no-series behavior.
- Open every dashboard and inspect row ordering, legends, units, table fields, links, and empty states.
- Confirm Loki trace tables show context fields and clickable trace IDs, not only dates.
- Confirm no implementation task modified the three already-remediated dashboards, YAML rules, source, tests, docs, or configuration files.

#### Where

- `dashboards/*.json` for validation
- No implementation file changes in this task unless a failure is assigned back to its dashboard task

#### Acceptance criteria

- All dashboard JSON files parse and format successfully.
- All repository dashboard tests pass.
- All panels have unique IDs/titles, valid geometry, and provisioned datasource UIDs.
- Every target and annotation query executes without HTTP 400, parser, scalar/vector, label-matching, or datasource errors.
- Every dashboard has working navigation and accurate empty-state guidance.
- Live tables and trace links render expected fields and destinations.
- Only the 11 in-scope dashboard JSON files differ as a result of this plan.

## Testing Strategy

Use four validation layers:

1. **Static document validation** — JSON parsing, required dashboard shape, datasource UIDs, unique IDs/titles, versions, and geometry.
2. **Repository contracts** — `test/dashboards.test.mjs` and formatting checks.
3. **Query execution** — Execute all PromQL, LogQL, and TraceQL targets after substituting realistic Grafana macro values. Test both a representative active range and an idle/no-series range.
4. **Rendered Grafana review** — Provision dashboards and inspect panel values, ordering, units, transformations, data links, variable cascading, and navigation.

Important edge cases:

- No metric series exists yet.
- Denominator exists but failure numerator does not.
- Multiple provider/model or tool series share partial labels.
- Selected ranges are very short or very long.
- Counters reset inside the selected range.
- Histogram series are sparse.
- Optional cache/reasoning/content metrics are unsupported.
- Loki records lack optional session, workflow, trace, or span labels.
- Grafana tables receive multiple Loki frames.
- Unsafe LLM content capture is explicitly enabled.
- Docker/live stack is unavailable; record the skipped live validation and do not claim it passed.

## Acceptance Criteria

- All 11 remaining dashboard JSON files are remediated one at a time.
- The three already-remediated dashboard files are not changed by this plan.
- Dashboard UIDs remain stable and versions increment.
- Schema versions are current and `__requires` matches used panel types.
- Query modes, units, windows, labels, and zero states are semantically correct.
- Alert/SLO thresholds match canonical YAML defaults or are clearly documented as tunable references.
- No PromQL expression passes scalar macros to vector-only functions.
- No forbidden high-cardinality identifiers are added to Prometheus expressions.
- Loki tables expose deterministic fields and working Tempo links.
- Navigation preserves time and supported variables without duplicating query parameters.
- Static tests, formatting, geometry checks, and live query execution pass.
- No non-dashboard code, test, documentation, configuration, alert, or SLO file is modified.

## Validation Commands

Execute these commands after each dashboard task where applicable, and execute the full set in Task 12:

- `jq -e 'type == "object"' dashboards/*.json` — Parse all dashboard JSON documents without shell redirection.
- `git diff --check -- dashboards/*.json` — Detect whitespace errors.
- `node --test test/dashboards.test.mjs` — Run dashboard shape, metric, label, link, and contract tests.
- `npm run format:check` — Validate repository formatting.
- `npm run validate:grafana-obs` — Run the existing Grafana observability flow validator.
- `npm run test:integration:grafana-stack` — Provision and validate the live stack when Docker is available; report a skip explicitly.
- `git status --short dashboards` — Confirm only intended dashboard JSON files changed.

For each dashboard, also use Grafana Query Inspector or the datasource APIs to execute every panel and annotation query. Static tests are not sufficient evidence that PromQL/LogQL/TraceQL parses.

## Notes

- Use `increase(...[$__range])` with `instant: true` for selected-range totals.
- Use `rate(...[$__rate_interval])` for rate trends and `increase(...[$__interval])` only for true interval-delta trends.
- Grafana `$__range_s` is a scalar. Arithmetic with it is valid, but `clamp_min($__range_s, ...)` and `clamp_max($__range_s, ...)` are invalid PromQL because those functions require instant vectors.
- For labeled ratios, zero-fill the numerator from the matching denominator labels before division; a bare `vector(0)` can erase label context.
- Use `scalar(...)` only when intentionally converting a one-sample aggregate vector for scalar arithmetic.
- Do not assume `labelsToFields` alone will render Loki labels. When a live table shows only timestamps, format a deterministic safe line and extract fields before hiding the raw line.
- Do not expose raw LLM prompt, response, thinking, tool argument, command, output, path, or error-message content in query strings, legends, or links.
- Do not mark live validation as passed when Docker or the backend is unavailable.
