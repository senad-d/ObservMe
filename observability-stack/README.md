# Observability Stack

A production-ready observability stack powered by **Grafana**, **Prometheus**, **Loki**, **Tempo**, and the **OpenTelemetry Collector**, fronted by **Nginx** with TLS termination. The stack is delivered via Docker Compose and includes opinionated defaults for retention, provisioning, and secure secret handling.

## Features
- **Grafana** with pre-provisioned data sources and dashboards
- **Prometheus** for metrics storage and scraping
- **Loki** for log aggregation
- **Tempo** for trace storage
- **OpenTelemetry Collector** for OTLP ingestion and fan-out to metrics/logs/traces
- **Nginx** reverse proxy with HTTPS and health checks
- **Certificate management** helpers for local dev and Let’s Encrypt rotation

## Prerequisites
- Docker Engine + Docker Compose plugin
- OpenSSL (for local dev certificates)
- (Optional) `certbot` and DNS/HTTP plugins for Let’s Encrypt automation

## Quick Start (Local)
1. **Move into the stack directory:**
   ```bash
   cd observability
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

4. **Generate a local TLS certificate:**
   ```bash
   ./scripts/generate-dev-cert.sh
   ```

5. **Map the domain locally:**
   ```text
   127.0.0.1 observability.local
   ```

6. **Start the stack:**
   ```bash
   docker compose up -d
   ```

7. **Open Grafana:**
   - URL: **https://observability.local**
   - User: `admin` (or `GRAFANA_ADMIN_USER` in `.env`)
   - Password: value from `secrets/grafana_admin_password`

## Configuration
- **Environment variables** are in `observability/.env`.
- **Service configs** live under `observability/config/`.
- **Nginx** configuration is at `observability/nginx/nginx.conf`.

> **Domain changes:** If you change `OBSERVABILITY_DOMAIN`, update `nginx/nginx.conf` and the TLS certificate filenames in `observability/secrets/`.

## Telemetry Ingestion
The OpenTelemetry Collector listens on:
- **gRPC:** `otel-collector:4317` inside Compose, published locally as `127.0.0.1:4317` by default
- **HTTP:** `otel-collector:4318` inside Compose, published locally as `127.0.0.1:4318` by default

Prometheus scrapes the collector’s self-observability metrics at `otel-collector:8888` and the OTLP metrics pipeline's Prometheus exporter at `otel-collector:8889`.

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

## TLS Certificates
- **Local development:** use `scripts/generate-dev-cert.sh`.
- **Let’s Encrypt rotation:** use `scripts/rotate_cert.sh` (see `observability/scripts/README.md`).

Certificates are stored in `observability/secrets/` and are **gitignored**.

## EC2 Bootstrap (Optional)
The `ec2/userdata.sh` script provisions Docker, pulls the repo, configures secrets, requests TLS certs, and starts the stack. It expects several environment variables (domain, repo URL/ref, Grafana credentials, and Let’s Encrypt settings).

See `ec2/userdata.sh` for the full list of required variables and behavior.

## Operations
Common commands from `observability`:
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
- Secrets in `deploy/observability/secrets/` are not versioned.
- Grafana admin password is reset from the secret on startup.
- TLS is terminated at Nginx; ensure certificates match your domain.
