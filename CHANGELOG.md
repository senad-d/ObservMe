# Changelog

## 0.1.0 - Unreleased

- Bootstrapped the ObservMe Pi extension repository from the pi-extension-template.
- Applied ObservMe project identity: package `@senad-d/observme`, repository `senad-d/ObservMe`, MIT license.
- Added preparation specs under `specs/`: project definition brief, architecture spec, guidelines spec, and task spec (all unimplemented, checkboxes unchecked).
- Audited `specs/spec-tasks.md` against every file in `ObservMe-Production-Docs/` and closed gaps: added tasks for the missing `npm run validate` scripts, alert rules/SLO definitions, compatibility matrix, Collector/Grafana-stack integration and chaos/performance tests, and startup-recovery/replay semantics; added the missing `observme.tenant.id` resource attribute and the unsafe-capture warning requirement; flagged an unresolved doc conflict between the template's source-shipping convention and the production blueprint's `dist/observme.js` build-artifact expectation for the implementation session to resolve.
- Restructured `specs/spec-tasks.md` from 18 coarse tasks into 58 session-sized tasks (one file, or one tightly coupled file pair, per task), so each task fits a single focused implementation session instead of bundling multiple unrelated files or Pi event families into one checkbox.
- Normalized `specs/spec-tasks.md` to the project task format: each task now has a `### <number>. <task_name>` heading, an unchecked checkbox, and explicit `Why`, `How`, `Where`, and `Acceptance criteria` sections.
- Reconciled spec/docs drift found during review: aligned branch/compaction summary attribute names, added missing branch lineage attributes, added `observme.tenant.id` and replay/eviction/truncation operational attributes to semantic conventions, completed query config defaults, and corrected the model/thinking-change task references.
- Added multi-agent workflow/agent-tree observability to the production docs and specs: `pi.workflow.*` correlation, `pi.agent.wait`/`pi.agent.join` spans, fan-out/depth/width/active-agent/orphan/trace-propagation metrics, workflow alerts/SLOs, `/obs agents` enhancements, config/env propagation, and implementation-task acceptance criteria.
- Retained `ObservMe-Production-Docs/` (production design/reference doc set) and `observability-stack/` (reference Grafana/Tempo/Loki/Prometheus/Collector Docker Compose stack) as companion assets.
- No ObservMe feature behavior (commands, OTEL export, redaction, agent lineage) is implemented yet; see `specs/spec-tasks.md` for the planned implementation sequence.
