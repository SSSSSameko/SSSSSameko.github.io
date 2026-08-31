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
soak_tmp_dir=''
service_template=''
next_link=''
previous_current=''
service_file_existed=0
service_was_active=0
service_was_enabled=0
activation_started=0
current_swapped=0
release_committed=0
backup_cleanup_failed=0
health_port=4173
node_path=''
weibo_browser_sandbox=1
source_revision=''
source_revision_short='unversioned'
service_memory_high_mb=700
service_memory_max_mb=850
service_recycle_interval_ms=86400000
service_recycle_seconds=86400

rollback_error() {
  echo "Rollback step failed: $1" >&2
  rollback_ok=0
}

service_is_healthy() {
  local expected_cwd="${1:-}"
  local verify_release_assets="${2:-1}"
  local main_pid=''
  local process_cwd=''

  systemctl is-active --quiet "${SERVICE_NAME}" || return 1
  main_pid="$(systemctl show "${SERVICE_NAME}" --property MainPID --value)" || return 1
  [[ "${main_pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  if [[ -n "${expected_cwd}" ]]; then
    process_cwd="$(readlink -f "/proc/${main_pid}/cwd")" || return 1
    [[ "${process_cwd}" == "${expected_cwd}" ]] || return 1
  fi

  node --input-type=module - "${health_port}" "${verify_release_assets}" <<'NODE'
const port = process.argv[2];
const verifyReleaseAssets = process.argv[3] === '1';
try {
  const request = (pathname) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    signal: AbortSignal.timeout(1500),
  });
  const health = await request('/api/health');
  const body = await health.json().catch(() => null);
  const healthy = health.ok
    && body?.ok === true
    && body?.service === 'sameko-weibo-lottery';
  if (!verifyReleaseAssets) process.exit(healthy ? 0 : 1);
  const [admin, adminScript, adminStyle, adminResponse] = await Promise.all([
    request('/admin'),
    request('/admin/admin.js'),
    request('/admin/admin.css'),
    request('/admin/api-response.js'),
  ]);
  const adminHtml = await admin.text();
  const assetsReady = [adminScript, adminStyle, adminResponse].every((response) => response.ok);
  process.exit(
    healthy
      && admin.ok
      && adminHtml.includes('id="loginPanel"')
      && assetsReady
      ? 0
      : 1,
  );
} catch {
  process.exit(1);
}
NODE
}

wait_for_service_health() {
  local expected_cwd="${1:-}"
  local attempts="${2:-30}"
  local verify_release_assets="${3:-1}"
  local attempt
  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    service_is_healthy "${expected_cwd}" "${verify_release_assets}" && return 0
    sleep 1
  done
  return 1
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
      if ! systemctl start "${SERVICE_NAME}" >/dev/null 2>&1; then
        rollback_error "restart previous release"
      elif ! wait_for_service_health "${previous_current}" 15 0; then
        rollback_error "verify previous release health"
      fi
    fi

    if (( rollback_ok == 1 )); then
      [[ -n "${release_dir}" ]] && rm -rf -- "${release_dir}"
      echo "Previous release restored." >&2
    else
      echo "Rollback was incomplete. Preserving diagnostics:" >&2
      [[ -n "${release_dir}" ]] && echo "  failed release: ${release_dir}" >&2
      [[ -n "${backup_dir}" ]] && echo "  service backup: ${backup_dir}" >&2
      backup_cleanup_failed=1
    fi
  elif (( status != 0 && release_committed == 0 )); then
    [[ -n "${release_dir}" ]] && rm -rf -- "${release_dir}"
  elif (( status != 0 )); then
    echo "Post-deployment cleanup failed; the healthy current release was kept." >&2
  fi

  [[ -n "${next_link}" ]] && rm -f -- "${next_link}"
  [[ -n "${service_template}" ]] && rm -f -- "${service_template}"
  [[ -n "${stage_dir}" ]] && rm -rf -- "${stage_dir}"
  [[ -n "${soak_tmp_dir}" ]] && rm -rf -- "${soak_tmp_dir}"
  if [[ -n "${backup_dir}" ]]; then
    if (( backup_cleanup_failed == 1 )); then
      echo "Preserving service backup: ${backup_dir}" >&2
    else
      rm -rf -- "${backup_dir}"
    fi
  fi
  exit "${status}"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

for command in node npm npx openssl systemctl install sed wc mktemp mv rm ln readlink date chown chmod flock runuser sleep timeout git tar; do
  command -v "${command}" >/dev/null || { echo "Missing command: ${command}" >&2; exit 1; }
done
node_path="$(readlink -f "$(command -v node)")"
[[ "${node_path}" == /* && -x "${node_path}" && "${node_path}" != *[[:space:]]* ]] \
  || { echo "Node must resolve to an executable absolute path without spaces." >&2; exit 1; }

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
exec 9>"${APP_DIR}/.deploy.lock"
flock -n 9 || { echo "Another deployment is already running for ${APP_DIR}." >&2; exit 1; }
install -d -m 0700 -o www-data -g www-data \
  "${APP_DIR}/output" \
  "${APP_DIR}/output/auth" \
  "${APP_DIR}/output/runtime-home" \
  "${APP_DIR}/output/runtime-cache"
chown -R --no-dereference www-data:www-data "${APP_DIR}/output"

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
  local normalized=''
  local lower_bound=''
  local upper_bound=''
  read_env_value "${key}" value || value="${fallback}"
  if [[ ! "${value}" =~ ^[0-9]+$ ]] || (( ${#value} > 64 )); then
    validation_error "${key} must be an integer from ${minimum} to ${maximum}."
    normalized="${fallback}"
  else
    normalized="${value#"${value%%[!0]*}"}"
    normalized="${normalized:-0}"
    lower_bound="${minimum#"${minimum%%[!0]*}"}"
    lower_bound="${lower_bound:-0}"
    upper_bound="${maximum#"${maximum%%[!0]*}"}"
    upper_bound="${upper_bound:-0}"
    if (( ${#normalized} < ${#lower_bound} )) \
      || (( ${#normalized} == ${#lower_bound} )) && [[ "${normalized}" < "${lower_bound}" ]] \
      || (( ${#normalized} > ${#upper_bound} )) \
      || (( ${#normalized} == ${#upper_bound} )) && [[ "${normalized}" > "${upper_bound}" ]]; then
      validation_error "${key} must be an integer from ${minimum} to ${maximum}."
      normalized="${fallback#"${fallback%%[!0]*}"}"
      normalized="${normalized:-0}"
    fi
  fi
  printf -v "${output_name}" '%s' "${normalized}"
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
  local reserved_key
  local reserved_value
  local -a origins=()

  for reserved_key in NODE_ENV NODE_OPTIONS MALLOC_ARENA_MAX HOST PLAYWRIGHT_BROWSERS_PATH HOME XDG_CACHE_HOME; do
    if read_env_value "${reserved_key}" reserved_value; then
      : "${reserved_value}"
      validation_error "${reserved_key} is managed by the systemd service and must not be set here."
    fi
  done

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
  if read_env_value WEIBO_BROWSER_SANDBOX weibo_browser_sandbox; then
    case "${weibo_browser_sandbox,,}" in
      1|true|yes) weibo_browser_sandbox=1 ;;
      0|false|no) weibo_browser_sandbox=0 ;;
      *)
        validation_error "WEIBO_BROWSER_SANDBOX must be 1 or 0."
        weibo_browser_sandbox=1
        ;;
    esac
  else
    weibo_browser_sandbox=1
  fi
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

source_root="$(readlink -f "${SOURCE_DIR}")"
[[ -d "${source_root}" ]] || { echo "Source directory is missing: ${SOURCE_DIR}" >&2; exit 1; }
if git -C "${source_root}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git_root="$(git -C "${source_root}" rev-parse --show-toplevel)"
  git_root="$(readlink -f "${git_root}")"
  [[ "${git_root}" == "${source_root}" ]] \
    || { echo "SOURCE_DIR must be the Git repository root: ${git_root}" >&2; exit 1; }
  [[ -z "$(git -C "${source_root}" status --porcelain --untracked-files=all)" ]] \
    || { echo "Refusing to deploy a dirty Git working tree. Commit or remove local changes first." >&2; exit 1; }
  source_revision="$(git -C "${source_root}" rev-parse --verify HEAD)"
  [[ "${source_revision}" =~ ^[0-9a-f]{40}$ ]] \
    || { echo "Unable to resolve the source commit." >&2; exit 1; }
  source_revision_short="${source_revision:0:12}"
elif [[ "${ALLOW_UNVERSIONED_SOURCE:-0}" != '1' ]]; then
  echo "SOURCE_DIR is not a Git repository. Set ALLOW_UNVERSIONED_SOURCE=1 only for a verified offline archive." >&2
  exit 1
else
  echo "Warning: deploying an unversioned offline source archive." >&2
fi

stage_dir="$(mktemp -d "${RELEASES_DIR}/.stage.XXXXXX")"
if [[ -n "${source_revision}" ]]; then
  git -C "${source_root}" archive --format=tar "${source_revision}" | tar -xf - -C "${stage_dir}"
else
node --input-type=module - "${source_root}" "${stage_dir}" "${ENV_FILE}" <<'NODE'
import fs from 'node:fs/promises';
import path from 'node:path';

const sourceDir = path.resolve(process.argv[2]);
const stageDir = path.resolve(process.argv[3]);
const envFile = path.resolve(process.argv[4]);
const ignoredRoots = new Set([
  '.deploy.lock', '.git', 'current', 'dist', 'ms-playwright', 'node_modules', 'output', 'releases',
]);
const sensitiveTextName = /(?:^|[-_.])(?:cookie|cookies|credential|credentials|secret|secrets|token|tokens)(?:[-_.]|$)/i;
const sensitiveTextExtension = /\.(?:conf|ini|json|log|txt|ya?ml)$/i;

function shouldSkipFile(name) {
  return name === '.env'
    || name.startsWith('.env.')
    || /\.(?:key|pem|p12|pfx)$/i.test(name)
    || (sensitiveTextExtension.test(name) && sensitiveTextName.test(name));
}

for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
  if (ignoredRoots.has(entry.name)
    || shouldSkipFile(entry.name)
    || entry.name.startsWith('.current-')
    || entry.name.startsWith('.install-backup.')) continue;
  const source = path.join(sourceDir, entry.name);
  if ((await fs.lstat(source)).isSymbolicLink()) continue;
  await fs.cp(source, path.join(stageDir, entry.name), {
    recursive: true,
    preserveTimestamps: true,
    filter: async (candidate) => {
      const name = path.basename(candidate);
      if (path.resolve(candidate) === envFile
        || shouldSkipFile(name)) return false;
      return !(await fs.lstat(candidate)).isSymbolicLink();
    },
  });
}
NODE
fi
printf '%s\n' "${source_revision:-unversioned}" >"${stage_dir}/.release-commit"

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

for item in server.mjs server-admin/admin.html server-admin/admin.css server-admin/admin.js server-admin/admin-list-state.js server-admin/api-response.js src/lib/weiboBrowserLifecycle.js dist/index.html node_modules ms-playwright; do
  [[ -e "${stage_dir}/${item}" ]] || { echo "Staged release is missing ${item}." >&2; exit 1; }
done
chown -R --no-dereference www-data:www-data "${stage_dir}"
chmod -R u+rwX,go-rwx "${stage_dir}"
soak_tmp_dir="$(mktemp -d "${APP_DIR}/.browser-soak.XXXXXX")"
chown www-data:www-data "${soak_tmp_dir}"
chmod 0700 "${soak_tmp_dir}"
timeout --signal=TERM --kill-after=10s 10m runuser -u www-data -- env \
  PLAYWRIGHT_BROWSERS_PATH="${stage_dir}/ms-playwright" \
  SAMEKO_BROWSER_SOAK_ROUNDS=2 \
  WEIBO_BROWSER_SANDBOX="${weibo_browser_sandbox}" \
  TMPDIR="${soak_tmp_dir}" \
  node "${stage_dir}/scripts/test-browser-lifecycle-soak.mjs"

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

app_dir_replacement="$(escape_sed_replacement "${APP_DIR}")"
env_file_replacement="$(escape_sed_replacement "${ENV_FILE}")"
node_path_replacement="$(escape_sed_replacement "${node_path}")"
service_template="$(mktemp)"
sed \
  -e "s|/opt/sameko-weibo-lottery|${app_dir_replacement}|g" \
  -e "s|/etc/sameko-weibo-lottery.env|${env_file_replacement}|g" \
  -e "s|/usr/bin/node|${node_path_replacement}|g" \
  -e "s|^Environment=PORT=.*|Environment=PORT=${health_port}|" \
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

release_dir="${RELEASES_DIR}/release-$(date -u +%Y%m%dT%H%M%SZ)-${source_revision_short}-$$"
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

if ! wait_for_service_health "${release_dir}" 30; then
  systemctl status --no-pager "${SERVICE_NAME}" || true
  exit 1
fi

release_committed=1
if rm -rf -- "${backup_dir}"; then
  backup_dir=''
else
  backup_cleanup_failed=1
  echo "Service backup cleanup failed; the healthy release was kept." >&2
fi

if ! node --input-type=module - "${RELEASES_DIR}" "${CURRENT_LINK}" <<'NODE'
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
then
  echo "Old release cleanup failed; the healthy current release was kept." >&2
fi

echo "Service health check passed: ${CURRENT_LINK} -> ${release_dir}"
