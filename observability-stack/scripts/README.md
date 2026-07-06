# Observability Certificate Rotation

This directory contains the Let's Encrypt rotation script used by cron on EC2.

## Files
- `rotate_cert.sh`: Requests or renews certificates via certbot and writes
  `fullchain.pem` and `privkey.pem` into `deploy/observability/secrets/`.

## Requirements
- `certbot` installed on the EC2 instance
- `openssl` available in PATH
- For HTTP-01: a reachable webroot directory
- For DNS-01: the correct certbot DNS plugin installed

## Usage

### HTTP-01 (webroot)
```bash
./rotate_cert.sh \
  --domain example.com \
  --domain www.example.com \
  --email admin@example.com \
  --method http \
  --webroot /var/www/html
```

### DNS-01 (Route53 plugin)
```bash
./rotate_cert.sh \
  --domains example.com,www.example.com \
  --email admin@example.com \
  --method dns \
  --dns-plugin route53
```

### Staging (recommended before first run)
```bash
./rotate_cert.sh --staging ...
```

## Environment Variables
You can set the following variables instead of flags:

- `LE_DOMAINS` (comma-separated list)
- `LE_EMAIL`
- `LE_METHOD` (`http` or `dns`)
- `LE_WEBROOT`
- `LE_DNS_PLUGIN`
- `LE_SECRETS_DIR`
- `LE_CERTBOT_PATH`
- `LE_STAGING` (`true` or `false`)

## Output
Certificates are written to:
- `deploy/observability/secrets/fullchain.pem`
- `deploy/observability/secrets/privkey.pem`

The script enforces `0700` on the secrets directory and `0600` on certificate
files.

## Cron Example (every 30 days)
```bash
0 2 */30 * * /Users/senad/Documents/Code/my_scripts/aws/deploy/observability/rotate_cert.sh \
  --domains example.com,www.example.com \
  --email admin@example.com \
  --method http \
  --webroot /var/www/html >> /var/log/rotate_cert.log 2>&1
```

## Notes
- The script uses `certbot certonly --keep-until-expiring` to avoid unnecessary
  reissues and rate limits.
- If another rotation is running, the script exits with a non-zero status.
- Keep `deploy/observability/secrets/` out of version control.
