# ObservMe Grafana + `/obs` validation flow

Use this secret-safe flow when Grafana shows ObservMe data but `/obs` commands appear broken. It classifies the failure as ingestion, labels, Grafana auth/query access, local TLS/DNS, Pi command registration, or session state.

## Preconditions

- The local stack is already running, for example `docker compose -f observability-stack/docker-compose.yml up -d`.
- The Pi session is active with ObservMe loaded from this checkout or the package under test.
- Grafana read access is provided through environment variables. Do not put tokens or passwords on the command line and do not source `.env` in captured logs.

```bash
export OBSERVME_GRAFANA_URL=https://observability.local
export OBSERVME_GRAFANA_TOKEN=<service-account-token>
# Or, for local-only Basic auth:
# export OBSERVME_GRAFANA_USERNAME=admin
# export OBSERVME_GRAFANA_PASSWORD=<local-password>

export OBSERVME_GRAFANA_TEMPO_DATASOURCE_UID=tempo
export OBSERVME_GRAFANA_LOKI_DATASOURCE_UID=loki
export OBSERVME_GRAFANA_PROMETHEUS_DATASOURCE_UID=prometheus
export OBSERVME_GRAFANA_TLS_INSECURE_SKIP_VERIFY=true
export OBSERVME_GRAFANA_PREFER_IPV4=true
export OBSERVME_OTLP_ENDPOINT=http://127.0.0.1:4318
```

## 1. Verify the active Pi command state

Inside the active Pi session, run:

```text
/obs status
/obs health
/obs session
/obs logs
/obs trace
```

Expected output:

- `/obs status` shows `ObservMe: enabled`, the intended Grafana URL, and `Grafana query readiness: ready`.
- `/obs health` shows `Collector: reachable`, `Grafana: reachable`, and Tempo/Loki/Metrics datasource checks as `ok`.
- `/obs session` shows a concrete session id instead of `unknown`.
- `/obs logs` shows session logs or a clear label/export failure hint.
- `/obs trace` returns a Grafana trace link. During an active session, child spans can appear before the root `pi.session` span; the root is exported after `session_shutdown`.

Copy the generated ids into your shell for the automated backend checks:

```bash
export OBSERVME_VALIDATION_SESSION_ID=<session-id-from-/obs-session>
# Optional but useful when /obs trace already returned a trace id:
export OBSERVME_VALIDATION_TRACE_ID=<32-hex-trace-id>
```

## 2. Run the local lifecycle flow test

Before using a live backend, the unit-level lifecycle flow can be reproduced without credentials:

```bash
node --test --test-name-pattern "deterministic active-session command flow" test/pi-handlers.test.mjs
```

This starts a fake ObservMe session, emits representative LLM, tool, bash, and subagent telemetry, checks active `/obs session` and `/obs trace` output, then runs `session_shutdown` and verifies root-span export state, bounded flush/shutdown calls, exporter-status messaging, and secret-safe output.

## 3. Run the deterministic validation script

```bash
npm run validate:grafana-obs
```

The script is read-only. It never reads `.env` or secret files, never prints token/password values, and does not mutate the running stack. It checks:

- Grafana API and datasource health with configured auth.
- One Prometheus ObservMe metric through the Grafana datasource proxy.
- One Loki query using normalized `service_name` and `pi_session_id` labels.
- One Tempo search by safe generated `pi.session.id`.
- Representative `/obs` command handlers: status, health, session, logs, and trace.

A passing run ends with:

```text
Result: PASS — Grafana has data and representative /obs commands work with the configured stack.
```

## 4. Verify the Export Health dashboard

Use this after representative telemetry has been emitted by the active local Pi session.

1. Open Grafana and select the `ObservMe Export Health` dashboard.
2. Confirm the healthy quiet state:
   - `Observed event liveness` or `Session lifecycle` shows recent activity for the selected range.
   - Telemetry drops, redaction failures, export failures, and handler error pressure render `0` when no failure series exists.
   - Active spans is zero or low after the session settles.
   - Failure log tables may be empty; empty means no matching failure logs in the selected range.
3. In a throwaway trusted local project, induce one safe failure mode at a time, then refresh the dashboard:
   - queue/span pressure should increment `observme_telemetry_dropped_total` and show `telemetry.dropped` rows;
   - redaction exceptions should increment `observme_redaction_failures_total` and show `redaction.failed` rows;
   - Collector/export failures should increment `observme_export_errors_total` and show `export.failed` rows.
4. Re-run `/obs status` and `/obs health` after each scenario. They should remain available, secret-safe, and pointed at the same local OTLP/Grafana configuration.

For deterministic, secret-safe signal-contract coverage without mutating the live stack, run:

```bash
node --test test/dashboards.test.mjs test/exporter-failure.test.ts test/chaos-failure.test.mjs test/pi-handlers.test.mjs
```

## Failure signatures

| Failed step | Likely class | Next check |
| --- | --- | --- |
| Grafana auth configuration | Missing query credentials | Export `OBSERVME_GRAFANA_TOKEN` or `OBSERVME_GRAFANA_USERNAME`/`OBSERVME_GRAFANA_PASSWORD`. |
| Grafana and datasource health | Grafana auth/query, local TLS/DNS, or datasource UID | Run `/obs health`; verify `observability.local`, TLS skip-verify for local dev, and datasource UIDs. |
| Prometheus metric ingestion | Collector metrics export or Prometheus scrape | Check Collector health, Prometheus targets, and `observme_*` metric names. |
| Loki log labels | Label mismatch or log export | Compare live Loki labels with `service_name`, `pi_session_id`, `event_name`, and `/obs logs` selectors. |
| Tempo trace search | Trace export, datasource UID, or active root-span timing | Wait for export, run `/obs trace`, and remember the root `pi.session` appears after shutdown. |
| `/obs command path` | Pi command state, session state, or command query mismatch | Re-run the Pi commands in step 1; then run `npm run smoke:pi-runtime` to isolate real Pi command registration. |

Release validation should not be considered complete while any step fails.
