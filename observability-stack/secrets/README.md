# Local secrets

Store local-only secrets in this directory. These files are ignored by git.

## Required files

- **Grafana admin password**: `grafana_admin_password`
  - Create a file containing the admin password on a single line.
  - Example: `echo "<PASSWORD>" > grafana_admin_password`
  - The Grafana entrypoint resets the admin password from this secret on startup, so UI changes will be overwritten on restart.

- **TLS certificate and key** for `observability.local`:
  - `observability.local.crt`
  - `observability.local.key`
  - If you change the domain, update the filenames and `nginx/nginx.conf`.

## Generate a dev certificate

```bash
cd deploy/observability
bash ./scripts/generate-dev-cert.sh
bash ./scripts/rotate_cert.sh
```

## For Dev Local DNS mapping

Ensure the host resolves to your local Docker host:

```
127.0.0.1 observability.local
```
