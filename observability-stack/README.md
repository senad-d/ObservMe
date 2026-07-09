# Observability Stack

A local-first observability stack powered by **Grafana**, **Prometheus**, **Loki**, **Tempo**, and the **OpenTelemetry Collector**, fronted by **Nginx** over plain HTTP on `localhost`. The stack is delivered via Docker Compose and includes opinionated defaults for retention, provisioning, and secure secret handling.

## Features
- **Grafana** with pre-provisioned data sources and dashboards
- **Prometheus** for metrics storage and scraping
- **Loki** for log aggregation
- **Tempo** for trace storage
- **OpenTelemetry Collector** for OTLP ingestion and fan-out to metrics/logs/traces
- **Nginx** reverse proxy with HTTP and health checks

## Prerequisites
- Docker Engine + Docker Compose plugin

## Quick Start (Local)
1. **Move into the stack directory:**
   ```bash
   cd observability-stack
   ```

2. **Create the environment file:**
   ```bash
   cp .env.example .env
   ```

3. **Create secrets:**
   ```bash
   mkdir -p secrets
   echo "<GRAFANA_ADMIN_PASSWORD>" > secrets/grafana_admin_password
   chmod 600 secrets/grafana_admin_password
   ```

4. **Start the stack:**
   ```bash
   docker compose up -d
   ```

5. **Open Grafana:**
   - URL: **http://localhost**
   - User: `admin` (or `GRAFANA_ADMIN_USER` in `.env`)
   - Password: value from `secrets/grafana_admin_password`

If port `80` is already in use, change `NGINX_HTTP_PORT` and `OBSERVABILITY_URL` in `.env` before starting the stack.

## ObservMe `/obs` Command Query Profile

The supported local command path is authenticated Grafana through Nginx over HTTP:

```yaml
query:
  enabled: true
  links:
    traceUrlTemplate: http://localhost/explore?left=...
  grafana:
    url: http://localhost
    token: ${OBSERVME_GRAFANA_TOKEN}
    username: admin
    password: ${OBSERVME_GRAFANA_PASSWORD}
    datasourceUids:
      tempo: tempo
      loki: loki
      prometheus: prometheus
```

Token setup options:

- Preferred: in Grafana, open Administration → Users and access → Service accounts, create a service account/token with Viewer access for read-only datasource queries, and export it as `OBSERVME_GRAFANA_TOKEN` before starting Pi.
- Local fallback: export `OBSERVME_GRAFANA_PASSWORD="$(cat secrets/grafana_admin_password)"` from this directory so ObservMe can use Basic auth with `username: admin`.
- Env-file option: copy the repository-root `.env.example` to `.env`, fill either `OBSERVME_GRAFANA_TOKEN` or `OBSERVME_GRAFANA_PASSWORD`, and restart Pi from that trusted project. System environment variables override `.env` values.

Browser login cookies are not used by the extension; `/obs health`, `/obs cost`, `/obs tools`, `/obs errors`, `/obs logs`, `/obs agents`, and `/obs trace --session` call the Grafana API directly. The local profile uses plain HTTP on `localhost`, so no self-signed certificate, hosts-file entry, or TLS skip-verify setting is required.

Provisioned datasource UIDs are `tempo`, `loki`, and `prometheus`. The Collector inserts `service.name=observme-pi-extension`; Loki receives normalized query labels including `service_name`, `pi_session_id`, `event_name`, and `event_category`. If data is visible in Grafana but `/obs` commands fail, confirm the env vars above are available to the extension through system env or trusted `.env`, then run `/obs health` and check Grafana auth, datasource UID, and Grafana URL details.

## Configuration
- **Stack service variables** are in `observability-stack/.env`; **extension variables** can be exported in your shell or placed in the repository-root `.env` copied from `.env.example`.
- **Service configs** live under `observability-stack/config/`.
- **Nginx** configuration is at `observability-stack/nginx/nginx.conf`.

> **URL changes:** If you change `NGINX_HTTP_PORT`, also update `OBSERVABILITY_URL` so Grafana generates links with the same host and port.

## Telemetry Ingestion
The OpenTelemetry Collector listens on:
- **gRPC:** `otel-collector:4317` inside Compose, published locally as `127.0.0.1:4317` by default
- **HTTP:** `otel-collector:4318` inside Compose, published locally as `127.0.0.1:4318` by default

Prometheus scrapes the collector’s self-observability metrics at `otel-collector:8888` and the OTLP metrics pipeline's Prometheus exporter at `otel-collector:8889`. The Prometheus exporter converts safe resource attributes to metric labels after high-cardinality Pi IDs are dropped, so concurrent ObservMe sessions remain separate series and aggregate session counts sum correctly.

### Pi agent ingestion path
Pi agents should not be pointed directly at this stack by default. The supported local path is:

```text
pi-agent JSONL stdout -> Docker JSON logs -> pibox gateway-side OTel filelog collector -> observability OTel collector -> Loki/Grafana
```

Configure `.local/gateway.env` in the repository root with:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
OTEL_EXPORTER_OTLP_TOKEN=
ENABLE_TIER2_LOGS=false
```

Then launch the gateway through `scripts/launch-gateway.sh`. The gateway-side collector resolves `host.docker.internal` from inside its container and forwards metadata-only agent events to this local collector. The Pi image starts through `pibox-agent-wrapper`, which emits baseline `agent.run.started` and terminal lifecycle JSONL events around the `pi` process. The Pi container still receives only its scoped `PI_GATEWAY_API_KEY`; do not add raw provider keys, GitHub credentials, or direct OTLP credentials to the Pi environment.

## Infrastructure Metrics (Host + Containers)
Prometheus also scrapes infrastructure exporters that are internal to `observability-backend`:
- **Node Exporter** (`node-exporter:9100`) for host CPU, memory, load, network, and filesystem metrics.
- **cAdvisor** (`cadvisor:8080`) for per-container CPU, memory, network, and container filesystem metrics.

Exporter ports are not published to the host; they are only reachable from services on the backend network.

Disk metric semantics can vary by runtime and storage driver. If `container_fs_usage_bytes` is host-scoped on a given host, use `container_fs_reads_bytes_total` / `container_fs_writes_bytes_total` for per-container disk trend monitoring and validate on the target environment.

### Validation Flow (Local First)
1. Validate local compose config:
   ```bash
   docker compose -f docker-compose.yml config --quiet
   ```
2. Start local stack and confirm targets:
   ```bash
   docker compose -f docker-compose.yml up -d
   docker compose -f docker-compose.yml exec prometheus wget -qO- http://localhost:9090/api/v1/targets
   ```
3. Validate online compose config with required S3 vars set:
   ```bash
   LOKI_S3_BUCKET=dummy TEMPO_S3_BUCKET=dummy docker compose -f docker-compose.online.yml config --quiet
   ```

## HTTPS / External Deployment
The local stack intentionally serves Grafana over plain HTTP at `http://localhost` to keep everyday setup simple. If you expose the stack outside your local machine, terminate HTTPS at an external reverse proxy/load balancer or adapt `nginx/nginx.conf` for your deployment.

Certificate helper scripts under `scripts/` are not required for the local Quick Start.

## EC2 Bootstrap (Optional)
The `ec2/userdata.sh` script provisions Docker, pulls the repo, configures secrets, and starts the stack. It expects several environment variables (domain or URL, repo URL/ref, and Grafana credentials).

See `ec2/userdata.sh` for the full list of required variables and behavior.

## Operations
Common commands from `observability-stack`:
```bash
# Start
docker compose up -d

# Stop
docker compose down

# View status
docker compose ps

# Logs
docker compose logs -f
```

## Security Notes
- Secrets in `observability-stack/secrets/` are not versioned.
- Grafana admin password is reset from the secret on startup.
- The default Nginx endpoint is HTTP-only for local use; add HTTPS before exposing it beyond localhost or a trusted network.
