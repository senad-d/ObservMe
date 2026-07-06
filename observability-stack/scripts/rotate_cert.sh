#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_NAME="$(basename "$0")"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEFAULT_SECRETS_DIR="${SCRIPT_DIR}/secrets"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

usage() {
  cat <<'EOF'
Usage: rotate_cert.sh [options]

Required:
  -d, --domain <domain>       Domain to request (repeatable)
  --domains <list>            Comma-separated domain list (alternative)
  -e, --email <email>         Let's Encrypt account email
  -m, --method <http|dns>     Challenge method

HTTP-01 options:
  --webroot <path>            Webroot path for http-01

DNS-01 options:
  --dns-plugin <name|flag>    DNS plugin (example: route53 or --dns-route53)

Optional:
  --secrets-dir <path>        Secrets directory (default: ./secrets)
  --certbot-path <path>       Certbot binary path (default: certbot)
  --staging                   Use Let's Encrypt staging endpoint
  -h, --help                  Show this help and exit

Environment equivalents:
  LE_DOMAINS, LE_EMAIL, LE_METHOD, LE_WEBROOT, LE_DNS_PLUGIN,
  LE_SECRETS_DIR, LE_CERTBOT_PATH, LE_STAGING
EOF
}

CERTBOT_BIN="certbot"
SECRETS_DIR="${DEFAULT_SECRETS_DIR}"
EMAIL=""
METHOD=""
WEBROOT=""
DNS_PLUGIN=""
STAGING="false"
DOMAINS=()

parse_domain_list() {
  local value="$1"
  local -a items=()
  IFS=',' read -r -a items <<< "${value}"
  local item
  for item in "${items[@]}"; do
    item="${item// /}"
    [[ -n "${item}" ]] && DOMAINS+=("${item}")
  done
}

parse_args() {
  local args=("$@")
  local i=0
  while [[ ${i} -lt ${#args[@]} ]]; do
    case "${args[i]}" in
      -d|--domain)
        DOMAINS+=("${args[i+1]:-}"); i=$((i+2)) ;;
      --domains)
        parse_domain_list "${args[i+1]:-}"; i=$((i+2)) ;;
      -e|--email)
        EMAIL="${args[i+1]:-}"; i=$((i+2)) ;;
      -m|--method)
        METHOD="${args[i+1]:-}"; i=$((i+2)) ;;
      --webroot)
        WEBROOT="${args[i+1]:-}"; i=$((i+2)) ;;
      --dns-plugin)
        DNS_PLUGIN="${args[i+1]:-}"; i=$((i+2)) ;;
      --secrets-dir)
        SECRETS_DIR="${args[i+1]:-}"; i=$((i+2)) ;;
      --certbot-path)
        CERTBOT_BIN="${args[i+1]:-}"; i=$((i+2)) ;;
      --staging)
        STAGING="true"; i=$((i+1)) ;;
      -h|--help)
        usage; exit 0 ;;
      *)
        die "Unknown argument: ${args[i]}" ;;
    esac
  done
}

apply_precedence() {
  if [[ ${#DOMAINS[@]} -eq 0 && -n "${LE_DOMAINS:-}" ]]; then
    parse_domain_list "${LE_DOMAINS}"
  fi
  [[ -z "${EMAIL}" && -n "${LE_EMAIL:-}" ]] && EMAIL="${LE_EMAIL}"
  [[ -z "${METHOD}" && -n "${LE_METHOD:-}" ]] && METHOD="${LE_METHOD}"
  [[ -z "${WEBROOT}" && -n "${LE_WEBROOT:-}" ]] && WEBROOT="${LE_WEBROOT}"
  [[ -z "${DNS_PLUGIN}" && -n "${LE_DNS_PLUGIN:-}" ]] && DNS_PLUGIN="${LE_DNS_PLUGIN}"
  [[ "${SECRETS_DIR}" == "${DEFAULT_SECRETS_DIR}" && -n "${LE_SECRETS_DIR:-}" ]] && \
    SECRETS_DIR="${LE_SECRETS_DIR}"
  [[ "${CERTBOT_BIN}" == "certbot" && -n "${LE_CERTBOT_PATH:-}" ]] && \
    CERTBOT_BIN="${LE_CERTBOT_PATH}"
  if [[ "${STAGING}" == "false" && -n "${LE_STAGING:-}" ]]; then
    STAGING="${LE_STAGING}"
  fi
}

require_cmd() {
  local cmd="$1"
  command -v "${cmd}" >/dev/null 2>&1 || die "${cmd} not found in PATH"
}

validate_inputs() {
  if [[ ${#DOMAINS[@]} -eq 0 ]]; then
    die "At least one --domain or LE_DOMAINS is required"
  fi
  local domain
  for domain in "${DOMAINS[@]}"; do
    [[ -z "${domain}" ]] && die "Domain entries cannot be empty"
  done
  [[ -z "${EMAIL}" ]] && die "--email or LE_EMAIL is required"
  case "${METHOD}" in
    http|dns) ;;
    *) die "--method must be http or dns" ;;
  esac
  if [[ "${METHOD}" == "http" ]]; then
    [[ -z "${WEBROOT}" ]] && die "--webroot is required for http method"
    [[ ! -d "${WEBROOT}" ]] && die "Webroot not found: ${WEBROOT}"
  fi
  if [[ "${METHOD}" == "dns" ]]; then
    [[ -z "${DNS_PLUGIN}" ]] && die "--dns-plugin is required for dns method"
  fi
  case "${STAGING}" in
    true|false) ;;
    *) die "--staging must be true or false" ;;
  esac
}

prepare_dirs() {
  mkdir -p "${SECRETS_DIR}"
  chmod 700 "${SECRETS_DIR}"

  CERTBOT_STATE_DIR="${SECRETS_DIR}/certbot"
  CERTBOT_CONFIG_DIR="${CERTBOT_STATE_DIR}/config"
  CERTBOT_WORK_DIR="${CERTBOT_STATE_DIR}/work"
  CERTBOT_LOGS_DIR="${CERTBOT_STATE_DIR}/logs"

  mkdir -p "${CERTBOT_CONFIG_DIR}" "${CERTBOT_WORK_DIR}" "${CERTBOT_LOGS_DIR}"
  chmod 700 "${CERTBOT_STATE_DIR}" "${CERTBOT_CONFIG_DIR}" \
    "${CERTBOT_WORK_DIR}" "${CERTBOT_LOGS_DIR}"
}

acquire_lock() {
  LOCK_PATH="${SECRETS_DIR}/.certbot.lock"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"${LOCK_PATH}"
    if ! flock -n 9; then
      die "Another certificate rotation is in progress"
    fi
  else
    if ! mkdir "${LOCK_PATH}" 2>/dev/null; then
      die "Another certificate rotation is in progress"
    fi
    LOCK_DIR_CREATED="true"
  fi
}

release_lock() {
  if [[ "${LOCK_DIR_CREATED:-}" == "true" ]]; then
    rm -rf "${LOCK_PATH}"
  fi
}

build_certbot_args() {
  CERTBOT_ARGS=(
    certonly
    --non-interactive
    --agree-tos
    --keep-until-expiring
    --email "${EMAIL}"
    --config-dir "${CERTBOT_CONFIG_DIR}"
    --work-dir "${CERTBOT_WORK_DIR}"
    --logs-dir "${CERTBOT_LOGS_DIR}"
  )

  if [[ "${STAGING}" == "true" ]]; then
    CERTBOT_ARGS+=(--staging)
  fi

  if [[ "${METHOD}" == "http" ]]; then
    CERTBOT_ARGS+=(--webroot --webroot-path "${WEBROOT}" --preferred-challenges http)
  else
    local dns_flag="${DNS_PLUGIN}"
    if [[ "${dns_flag}" != --* ]]; then
      dns_flag="--dns-${dns_flag}"
    fi
    CERTBOT_ARGS+=("${dns_flag}")
  fi

  local domain
  for domain in "${DOMAINS[@]}"; do
    CERTBOT_ARGS+=(-d "${domain}")
  done
}

sync_outputs() {
  local primary_domain="${DOMAINS[0]}"
  local live_dir="${CERTBOT_CONFIG_DIR}/live/${primary_domain}"
  local fullchain_src="${live_dir}/fullchain.pem"
  local privkey_src="${live_dir}/privkey.pem"

  [[ -f "${fullchain_src}" ]] || die "Missing fullchain: ${fullchain_src}"
  [[ -f "${privkey_src}" ]] || die "Missing privkey: ${privkey_src}"

  local tmp_dir
  tmp_dir="$(mktemp -d "${SECRETS_DIR}/.tmp.XXXXXX")"
  cp "${fullchain_src}" "${tmp_dir}/fullchain.pem"
  cp "${privkey_src}" "${tmp_dir}/privkey.pem"
  chmod 600 "${tmp_dir}/fullchain.pem" "${tmp_dir}/privkey.pem"

  mv -f "${tmp_dir}/fullchain.pem" "${SECRETS_DIR}/fullchain.pem"
  mv -f "${tmp_dir}/privkey.pem" "${SECRETS_DIR}/privkey.pem"
  rmdir "${tmp_dir}"

  chmod 600 "${SECRETS_DIR}/fullchain.pem" "${SECRETS_DIR}/privkey.pem"
}

log_expiry() {
  local expiry
  expiry="$(openssl x509 -enddate -noout -in "${SECRETS_DIR}/fullchain.pem" \
    | cut -d= -f2-)"
  if [[ -n "${expiry}" ]]; then
    log "Certificate expires: ${expiry}"
  fi
}

cleanup() {
  release_lock
  if [[ -n "${TMP_DIR:-}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
}

main() {
  export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"
  umask 077

  trap cleanup EXIT

  parse_args "$@"
  apply_precedence
  validate_inputs

  require_cmd "${CERTBOT_BIN}"
  require_cmd openssl

  prepare_dirs
  acquire_lock

  build_certbot_args
  log "Starting certificate rotation for: ${DOMAINS[*]}"
  log "Using secrets dir: ${SECRETS_DIR}"
  log "Running certbot command"

  "${CERTBOT_BIN}" "${CERTBOT_ARGS[@]}"

  sync_outputs
  log "Certificates written to ${SECRETS_DIR}/fullchain.pem and privkey.pem"
  log_expiry
}

main "$@"
