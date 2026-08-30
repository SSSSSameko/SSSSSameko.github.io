#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/sameko-weibo-lottery}"
SOURCE_DIR="${SOURCE_DIR:-${APP_DIR}}"
ENV_FILE="${ENV_FILE:-/etc/sameko-weibo-lottery.env}"
SERVICE_FILE="/etc/systemd/system/sameko-weibo-lottery.service"
SERVICE_NAME="sameko-weibo-lottery.service"
CORS_ORIGINS="${CORS_ORIGINS:-https://sssssameko.github.io}"
RELEASES_DIR="${APP_DIR}/releases"
CURRENT_LINK="${APP_DIR}/current"

stage_dir=''
release_dir=''
backup_dir=''
service_template=''
next_link=''
previous_current=''
service_file_existed=0
service_was_active=0
service_was_enabled=0
activation_started=0
current_swapped=0
release_committed=0

rollback_error() {
  echo "Rollback step failed: $1" >&2
  rollback_ok=0
}

cleanup() {
  local status=$?
  local rollback_ok=1
  local rollback_link=''
  trap - EXIT INT TERM
  set +e

  if (( status != 0 && activation_started == 1 && release_committed == 0 )); then
    echo "Deployment failed; restoring the previous release." >&2
    systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || rollback_error "stop ${SERVICE_NAME}"

    if (( current_swapped == 1 )); then
      if [[ -n "${previous_current}" ]]; then
        rollback_link="${APP_DIR}/.current-rollback.$$"
        rm -f -- "${rollback_link}"
        if ! ln -s -- "${previous_current}" "${rollback_link}"; then
          rollback_error "create previous-release link"
        elif ! mv -Tf -- "${rollback_link}" "${CURRENT_LINK}"; then
          rollback_error "restore previous-release link"
        fi
      elif ! rm -f -- "${CURRENT_LINK}"; then
        rollback_error "remove first-release link"
      fi
    fi

    if (( service_file_existed == 1 )); then
      install -m 0644 "${backup_dir}/${SERVICE_NAME}" "${SERVICE_FILE}" \
        || rollback_error "restore systemd service"
    else
      rm -f -- "${SERVICE_FILE}" || rollback_error "remove new systemd service"
    fi
    systemctl daemon-reload >/dev/null 2>&1 || rollback_error "reload systemd"

    if (( service_was_enabled == 1 )); then
      systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || rollback_error "re-enable service"
    else
      systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || rollback_error "restore disabled state"
    fi
    if (( service_was_active == 1 )); then
      systemctl start "${SERVICE_NAME}" >/dev/null 2>&1 || rollback_error "restart previous release"
    fi

    if (( rollback_ok == 1 )); then
      [[ -n "${release_dir}" ]] && rm -rf -- "${release_dir}"
      echo "Previous release restored." >&2
    else
      echo "Rollback was incomplete. Preserving diagnostics:" >&2
      [[ -n "${release_dir}" ]] && echo "  failed release: ${release_dir}" >&2
      [[ -n "${backup_dir}" ]] && echo "  service backup: ${backup_dir}" >&2
      release_dir=''
      backup_dir=''
    fi
  elif (( status != 0 )); then
    [[ -n "${release_dir}" ]] && rm -rf -- "${release_dir}"
  fi

  [[ -n "${next_link}" ]] && rm -f -- "${next_link}"
  [[ -n "${service_template}" ]] && rm -f -- "${service_template}"
  [[ -n "${stage_dir}" ]] && rm -rf -- "${stage_dir}"
  [[ -n "${backup_dir}" ]] && rm -rf -- "${backup_dir}"
  exit "${status}"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

for command in node npm npx openssl systemctl install sed wc mktemp mv rm ln readlink date chown chmod; do
  command -v "${command}" >/dev/null || { echo "Missing command: ${command}" >&2; exit 1; }
done

[[ "${APP_DIR}" == /* && "${APP_DIR}" != / && "${APP_DIR}" != *[[:space:]]* ]] \
  || { echo "APP_DIR must be an absolute path without spaces." >&2; exit 1; }
[[ "${SOURCE_DIR}" == /* ]] || { echo "SOURCE_DIR must be an absolute path." >&2; exit 1; }
[[ "${ENV_FILE}" == /* && "${ENV_FILE}" != *[[:space:]]* ]] \
  || { echo "ENV_FILE must be an absolute path without spaces." >&2; exit 1; }
[[ ! -L "${APP_DIR}" ]] || { echo "APP_DIR must not be a symbolic link: ${APP_DIR}" >&2; exit 1; }
[[ -f "${SOURCE_DIR}/package.json" ]] || { echo "Project source not found at ${SOURCE_DIR}" >&2; exit 1; }
[[ ! -L "${ENV_FILE}" ]] || { echo "ENV_FILE must not be a symbolic link: ${ENV_FILE}" >&2; exit 1; }
[[ ! -e "${ENV_FILE}" || -f "${ENV_FILE}" ]] || { echo "ENV_FILE must be a regular file: ${ENV_FILE}" >&2; exit 1; }

install -d -m 0755 "${APP_DIR}" "${RELEASES_DIR}"
install -d -m 0700 -o www-data -g www-data \
  "${APP_DIR}/output" \
  "${APP_DIR}/output/auth" \
  "${APP_DIR}/output/runtime-home" \
  "${APP_DIR}/output/runtime-cache"

if [[ ! -s "${ENV_FILE}" ]]; then
  read -r -p "Admin username [sameko-admin]: " admin_username
  admin_username="${admin_username:-sameko-admin}"
  [[ "${admin_username}" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "Invalid admin username." >&2; exit 1; }
  read -r -s -p "Admin password: " admin_password
  echo
  admin_password_hash="$(printf '%s' "${admin_password}" | node "${SOURCE_DIR}/scripts/hash-admin-password.mjs")"
  unset admin_password

  umask 077
  cat >"${ENV_FILE}" <<EOF
ADMIN_USERNAME=${admin_username}
ADMIN_PASSWORD_HASH=${admin_password_hash}
ADMIN_SESSION_SECRET=$(openssl rand -hex 32)
COOKIE_WRITE_KEY=$(openssl rand -hex 32)
SOURCE_FINGERPRINT_SECRET=$(openssl rand -hex 32)
CORS_ORIGINS=${CORS_ORIGINS}
EOF
else
  echo "Keeping existing ${ENV_FILE}."
fi

read_env_value() {
  local key="$1"
  local output_name="$2"
  local line name value
  local found=1

  printf -v "${output_name}" '%s' ''
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}"
    [[ "${name}" == "${key}" ]] || continue
    value="${BASH_REMATCH[2]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ ${#value} -ge 2 && "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ ${#value} -ge 2 && "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf -v "${output_name}" '%s' "${value}"
    found=0
  done <"${ENV_FILE}"
  return "${found}"
}

validation_failed=0
validation_error() {
  echo "Invalid ${ENV_FILE}: $1" >&2
  validation_failed=1
}

validate_hex_key() {
  local key_name="$1"
  local key_value="$2"
  local required="$3"
  if [[ -z "${key_value}" ]]; then
    [[ "${required}" == 0 ]] || validation_error "${key_name} is required and must be 64 hexadecimal characters."
  elif [[ ! "${key_value}" =~ ^[A-Fa-f0-9]{64}$ ]]; then
    validation_error "${key_name} must be 64 hexadecimal characters."
  fi
}

read_integer_setting() {
  local key="$1"
  local output_name="$2"
  local fallback="$3"
  local minimum="$4"
  local maximum="$5"
  local value=''
  read_env_value "${key}" value || value="${fallback}"
  if [[ ! "${value}" =~ ^[0-9]+$ ]] || (( 10#${value} < minimum || 10#${value} > maximum )); then
    validation_error "${key} must be an integer from ${minimum} to ${maximum}."
    value="${fallback}"
  fi
  printf -v "${output_name}" '%s' "$((10#${value}))"
}

validate_env_file() {
  local admin_username=''
  local admin_password_hash=''
  local admin_session_secret=''
  local cookie_write_key=''
  local source_fingerprint_secret=''
  local port_value=''
  local cors_origins=''
  local secret_bytes=0
  local origin
  local -a origins=()

  if ! read_env_value ADMIN_USERNAME admin_username; then
    validation_error "ADMIN_USERNAME is required and must match [A-Za-z0-9._-]{1,64}."
  elif [[ ! "${admin_username}" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
    validation_error "ADMIN_USERNAME must match [A-Za-z0-9._-]{1,64}."
  fi
  if ! read_env_value ADMIN_PASSWORD_HASH admin_password_hash; then
    validation_error "ADMIN_PASSWORD_HASH is required and must be a scrypt hash."
  elif [[ ! "${admin_password_hash}" =~ ^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$ ]]; then
    validation_error "ADMIN_PASSWORD_HASH must match scrypt\$<salt>\$<hash>."
  fi
  if ! read_env_value ADMIN_SESSION_SECRET admin_session_secret; then
    validation_error "ADMIN_SESSION_SECRET is required and must be at least 32 bytes."
  else
    secret_bytes="$(LC_ALL=C printf '%s' "${admin_session_secret}" | LC_ALL=C wc -c)"
    (( secret_bytes >= 32 )) || validation_error "ADMIN_SESSION_SECRET must be at least 32 bytes."
  fi

  read_env_value COOKIE_WRITE_KEY cookie_write_key || true
  validate_hex_key COOKIE_WRITE_KEY "${cookie_write_key}" 0
  read_env_value SOURCE_FINGERPRINT_SECRET source_fingerprint_secret || true
  validate_hex_key SOURCE_FINGERPRINT_SECRET "${source_fingerprint_secret}" 0

  if read_env_value PORT port_value; then
    if [[ ! "${port_value}" =~ ^[0-9]{1,5}$ ]] || (( 10#${port_value} < 1 || 10#${port_value} > 65535 )); then
      validation_error "PORT must be an integer from 1 to 65535."
      health_port=4173
    else
      health_port=$((10#${port_value}))
    fi
  else
    health_port=4173
  fi

  if ! read_env_value CORS_ORIGINS cors_origins; then
    cors_origins='https://sssssameko.github.io'
  fi
  if [[ -z "${cors_origins}" || "${cors_origins}" == ,* || "${cors_origins}" == *, || "${cors_origins}" == *,,* ]]; then
    validation_error "CORS_ORIGINS must contain one or more comma-separated origins."
  else
    IFS=',' read -r -a origins <<<"${cors_origins}"
    for origin in "${origins[@]}"; do
      origin="${origin#"${origin%%[![:space:]]*}"}"
      origin="${origin%"${origin##*[![:space:]]}"}"
      if [[ -z "${origin}" ]] || ! node - "${origin}" >/dev/null 2>&1 <<'NODE'
const value = process.argv[2];
try {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search
    || url.hash) process.exit(1);
} catch {
  process.exit(1);
}
NODE
      then
        validation_error "CORS_ORIGINS must contain only http:// or https:// origins without paths."
        break
      fi
    done
  fi

  read_integer_setting SERVICE_MEMORY_HIGH_MB service_memory_high_mb 700 128 65536
  read_integer_setting SERVICE_MEMORY_MAX_MB service_memory_max_mb 850 128 65536
  read_integer_setting SERVICE_RECYCLE_INTERVAL_MS service_recycle_interval_ms 86400000 60000 2592000000
  if (( service_memory_high_mb > service_memory_max_mb )); then
    validation_error "SERVICE_MEMORY_HIGH_MB must not exceed SERVICE_MEMORY_MAX_MB."
  fi
  service_recycle_seconds=$(((service_recycle_interval_ms + 999) / 1000))

  (( validation_failed == 0 )) || return 1
}

if ! validate_env_file; then
  echo "Configuration validation failed; systemd was not changed." >&2
  exit 1
fi
chown root:root "${ENV_FILE}"
chmod 0600 "${ENV_FILE}"

stage_dir="$(mktemp -d "${RELEASES_DIR}/.stage.XXXXXX")"
node --input-type=module - "${SOURCE_DIR}" "${stage_dir}" <<'NODE'
import fs from 'node:fs/promises';
import path from 'node:path';

const sourceDir = path.resolve(process.argv[2]);
const stageDir = path.resolve(process.argv[3]);
const ignoredRoots = new Set([
  '.git', 'current', 'dist', 'ms-playwright', 'node_modules', 'output', 'releases',
]);

for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
  if (ignoredRoots.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.')) continue;
  const source = path.join(sourceDir, entry.name);
  if ((await fs.lstat(source)).isSymbolicLink()) continue;
  await fs.cp(source, path.join(stageDir, entry.name), {
    recursive: true,
    preserveTimestamps: true,
    filter: async (candidate) => {
      const name = path.basename(candidate);
      if (name === '.env' || name.startsWith('.env.') || /\.(?:key|pem)$/i.test(name)) return false;
      return !(await fs.lstat(candidate)).isSymbolicLink();
    },
  });
}
NODE

(
  cd "${stage_dir}"
  npm ci
  npm run licenses:check
  npm run build
  node --check server.mjs
  node --check server-admin/admin.js
  export PLAYWRIGHT_BROWSERS_PATH="${stage_dir}/ms-playwright"
  npx playwright install --with-deps chromium
)

for item in server.mjs server-admin/admin.js src/lib/weiboBrowserLifecycle.js dist/index.html node_modules ms-playwright; do
  [[ -e "${stage_dir}/${item}" ]] || { echo "Staged release is missing ${item}." >&2; exit 1; }
done
chmod -R a+rX "${stage_dir}"

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

app_dir_replacement="$(escape_sed_replacement "${APP_DIR}")"
current_link_replacement="$(escape_sed_replacement "${CURRENT_LINK}")"
env_file_replacement="$(escape_sed_replacement "${ENV_FILE}")"
service_template="$(mktemp)"
sed \
  -e "s|/opt/sameko-weibo-lottery/current|${current_link_replacement}|g" \
  -e "s|/opt/sameko-weibo-lottery|${app_dir_replacement}|g" \
  -e "s|/etc/sameko-weibo-lottery.env|${env_file_replacement}|g" \
  -e "s|^Environment=SERVICE_RECYCLE_INTERVAL_MS=.*|Environment=SERVICE_RECYCLE_INTERVAL_MS=${service_recycle_interval_ms}|" \
  -e "s|^Environment=SERVICE_MEMORY_HIGH_MB=.*|Environment=SERVICE_MEMORY_HIGH_MB=${service_memory_high_mb}|" \
  -e "s|^Environment=SERVICE_MEMORY_MAX_MB=.*|Environment=SERVICE_MEMORY_MAX_MB=${service_memory_max_mb}|" \
  -e "s|^RuntimeMaxSec=.*|RuntimeMaxSec=${service_recycle_seconds}s|" \
  -e "s|^MemoryHigh=.*|MemoryHigh=${service_memory_high_mb}M|" \
  -e "s|^MemoryMax=.*|MemoryMax=${service_memory_max_mb}M|" \
  "${stage_dir}/deploy/sameko-weibo-lottery.service" >"${service_template}"

[[ ! -L "${SERVICE_FILE}" ]] || { echo "Service file must not be a symbolic link: ${SERVICE_FILE}" >&2; exit 1; }
backup_dir="$(mktemp -d "${APP_DIR}/.install-backup.XXXXXX")"
if [[ -e "${SERVICE_FILE}" ]]; then
  [[ -f "${SERVICE_FILE}" ]] || { echo "Service file must be regular: ${SERVICE_FILE}" >&2; exit 1; }
  install -m 0644 "${SERVICE_FILE}" "${backup_dir}/${SERVICE_NAME}"
  service_file_existed=1
fi
if systemctl is-enabled --quiet "${SERVICE_NAME}"; then service_was_enabled=1; fi
if systemctl is-active --quiet "${SERVICE_NAME}"; then service_was_active=1; fi

if [[ -L "${CURRENT_LINK}" ]]; then
  previous_current="$(readlink -f "${CURRENT_LINK}")"
  [[ -d "${previous_current}" ]] || { echo "Current release target is missing: ${previous_current}" >&2; exit 1; }
elif [[ -e "${CURRENT_LINK}" ]]; then
  echo "CURRENT_LINK must be a symbolic link: ${CURRENT_LINK}" >&2
  exit 1
fi

release_dir="${RELEASES_DIR}/release-$(date -u +%Y%m%dT%H%M%SZ)-$$"
[[ ! -e "${release_dir}" ]] || { echo "Release path already exists: ${release_dir}" >&2; exit 1; }
mv -- "${stage_dir}" "${release_dir}"
stage_dir=''

activation_started=1
if (( service_was_active == 1 )); then systemctl stop "${SERVICE_NAME}"; fi

next_link="${APP_DIR}/.current-next.$$"
ln -s -- "${release_dir}" "${next_link}"
mv -Tf -- "${next_link}" "${CURRENT_LINK}"
next_link=''
current_swapped=1

install -m 0644 "${service_template}" "${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl start "${SERVICE_NAME}"

healthy=0
for _ in {1..30}; do
  if node -e "fetch('http://127.0.0.1:${health_port}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    healthy=1
    break
  fi
  sleep 1
done
[[ ${healthy} -eq 1 ]] || { systemctl status --no-pager "${SERVICE_NAME}"; exit 1; }

release_committed=1
rm -rf -- "${backup_dir}"
backup_dir=''

node --input-type=module - "${RELEASES_DIR}" "${CURRENT_LINK}" <<'NODE'
import fs from 'node:fs/promises';
import path from 'node:path';

const releasesDir = path.resolve(process.argv[2]);
const current = await fs.realpath(process.argv[3]);
const releases = [];
for (const entry of await fs.readdir(releasesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('release-')) continue;
  const target = path.join(releasesDir, entry.name);
  releases.push({ target, mtimeMs: (await fs.stat(target)).mtimeMs });
}
releases.sort((left, right) => right.mtimeMs - left.mtimeMs);
let previousKept = 0;
for (const release of releases) {
  if (release.target === current) continue;
  if (previousKept < 2) {
    previousKept += 1;
    continue;
  }
  await fs.rm(release.target, { recursive: true, force: true });
}
NODE

echo "Service health check passed: ${CURRENT_LINK} -> ${release_dir}"
