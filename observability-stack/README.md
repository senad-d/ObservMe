# ObservMe local observability stack

This repository-only Docker Compose stack runs Grafana, Prometheus, Loki, Tempo, and the OpenTelemetry Collector for local ObservMe development. Nginx exposes authenticated Grafana over plain HTTP at `http://localhost`; the Collector publishes OTLP on localhost ports 4317 and 4318.

The stack is not included in the npm package. Do not expose this local profile outside a trusted machine without adding production authentication, TLS, network controls, and appropriate retention/storage.

## Prerequisites

- Docker Engine with the Docker Compose plugin
- OpenSSL, or another secure password generator

## Quick start

From a repository checkout:

```bash
cd observability-stack
cp .env.example .env
mkdir -p secrets
if [ ! -s secrets/grafana_admin_password ]; then
  openssl rand -hex 24 > secrets/grafana_admin_password
fi
chmod 600 secrets/grafana_admin_password
docker compose up -d
```

Open `http://localhost` and sign in with user `admin` (or `GRAFANA_ADMIN_USER`) and the generated password in `secrets/grafana_admin_password`.

If host port 80 is unavailable, set both `NGINX_HTTP_PORT` and the matching port in `OBSERVABILITY_URL` before starting the stack. Grafana itself is not published directly on `localhost:3000`; Nginx is the supported host entrypoint.

## Configure ObservMe

The generated project starter and [`../examples/observme.yaml`](../examples/observme.yaml) use this profile:

```yaml
observme:
  environment: development
  otlp:
    endpoint: http://localhost:4318
  privacy:
    allowInsecureTransport: true
  query:
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
      tls:
        insecureSkipVerify: false
      transport:
        preferIPv4: false
```

Create a Grafana service-account token with Viewer access and set `OBSERVME_GRAFANA_TOKEN`, or use local Basic auth by setting `OBSERVME_GRAFANA_USERNAME=admin` and `OBSERVME_GRAFANA_PASSWORD` to the generated admin password. Supply secrets through the process environment or a trusted project `.env`; never put real credentials in YAML or commit them.

Browser cookies are not used by `/obs` commands. Restart Pi after changing its environment, then run:

```text
/obs status
/obs health
/obs session
/obs trace
```

## Services and endpoints

| Service | Host access | Purpose |
| --- | --- | --- |
| Nginx/Grafana | `http://localhost` (port controlled by `NGINX_HTTP_PORT`) | Authenticated UI and Grafana datasource API used by `/obs` queries. |
| OpenTelemetry Collector | `localhost:4317` gRPC, `http://localhost:4318` HTTP | Receives ObservMe OTLP traces, metrics, and logs. |
| Prometheus | Internal only | Scrapes Collector self-metrics, exported ObservMe metrics, node-exporter, and cAdvisor. |
| Loki | Internal only | Stores ObservMe OTEL logs. |
| Tempo | Internal only | Stores ObservMe traces. |
| node-exporter / cAdvisor | Internal only | Local host and container infrastructure metrics. |

Grafana provisions datasource UIDs `prometheus`, `loki`, and `tempo`, plus the dashboards from [`../dashboards/`](../dashboards/). The Collector inserts `service.name=observme-pi-extension`, removes high-cardinality Pi identifiers from metrics, and provides normalized Loki labels such as `service_name`, `pi_session_id`, `event_name`, and `event_category`.

## Validate and operate

```bash
# Validate Compose interpolation
docker compose config --quiet

# Start and inspect
docker compose up -d
docker compose ps

# Follow service logs
docker compose logs -f

# Stop while retaining named volumes
docker compose down

# Stop and delete local telemetry data
docker compose down -v
```

For the extension/backend validation flow, return to the repository root and follow [`../docs/validation-flow.md`](../docs/validation-flow.md). For version evidence, see [`../docs/compatibility-matrix.md`](../docs/compatibility-matrix.md).

## Security notes

- Keep `secrets/grafana_admin_password` and `.env` uncommitted and mode-restricted.
- The default Nginx endpoint is plain local HTTP. Set `privacy.allowInsecureTransport: true` only for this controlled development profile.
- Do not expose Grafana, OTLP ports, or internal backend networks publicly without production controls.
- Keep optional content capture disabled unless explicitly needed; retain redaction and a tenant hash salt when capture is enabled.
