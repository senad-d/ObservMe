#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="${ROOT_DIR}/secrets"
DOMAIN="${1:-observability.local}"
CERT_PATH="${SECRETS_DIR}/${DOMAIN}.crt"
KEY_PATH="${SECRETS_DIR}/${DOMAIN}.key"

mkdir -p "${SECRETS_DIR}"

openssl req -x509 -nodes -newkey rsa:4096 \
  -days 365 \
  -keyout "${KEY_PATH}" \
  -out "${CERT_PATH}" \
  -subj "/CN=${DOMAIN}" \
  -addext "subjectAltName=DNS:${DOMAIN}"

chmod 600 "${KEY_PATH}"

echo "Created ${CERT_PATH} and ${KEY_PATH}"
