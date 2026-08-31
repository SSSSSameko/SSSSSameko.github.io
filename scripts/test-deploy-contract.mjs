import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [installer, service, caddy] = await Promise.all([
  readFile(new URL('../deploy/install.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/sameko-weibo-lottery.service', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/Caddyfile', import.meta.url), 'utf8'),
]);

const servicePort = service.match(/^Environment=PORT=(\d+)$/m)?.[1];
const proxyPort = caddy.match(/reverse_proxy\s+127\.0\.0\.1:(\d+)/)?.[1];
assert.ok(servicePort);
assert.equal(proxyPort, servicePort);

const swapCommand = 'mv -Tf -- "${next_link}" "${CURRENT_LINK}"';
const swappedFlag = 'current_swapped=1';
assert.ok(installer.indexOf(swapCommand) >= 0);
assert.ok(installer.indexOf(swappedFlag, installer.indexOf(swapCommand)) > installer.indexOf(swapCommand));
assert.match(installer, /Environment=PORT=\.\*\|Environment=PORT=\$\{health_port\}/);
assert.doesNotMatch(installer, /current_link_replacement/);

for (const asset of ['admin.html', 'admin.css', 'admin.js', 'admin-list-state.js', 'api-response.js']) {
  assert.match(installer, new RegExp(`server-admin/${asset.replace('.', '\\.')}\\b`));
}

assert.match(installer, /SAMEKO_BROWSER_SOAK_ROUNDS=([2-8])/);
assert.match(installer, /WEIBO_BROWSER_SANDBOX="\$\{weibo_browser_sandbox\}"/);
assert.match(installer, /timeout --signal=TERM --kill-after=10s 10m runuser -u www-data/);
assert.match(installer, /wait_for_service_health "\$\{previous_current\}" 15 0/);
assert.match(installer, /local verify_release_assets="\$\{2:-1\}"/);
assert.match(installer, /git -C "\$\{source_root\}" archive --format=tar "\$\{source_revision\}" \| tar -xf -/);
assert.match(installer, /Refusing to deploy a dirty Git working tree/);
assert.match(installer, /ALLOW_UNVERSIONED_SOURCE=1/);
assert.match(installer, />"\$\{stage_dir\}\/\.release-commit"/);
assert.match(installer, /soak_tmp_dir="\$\(mktemp -d/);
assert.match(installer, /TMPDIR="\$\{soak_tmp_dir\}"/);
assert.doesNotMatch(installer, /SAMEKO_BROWSER_SOAK_ROUNDS=1/);
assert.doesNotMatch(installer, /chmod -R a\+rX/);
assert.match(installer, /sensitiveTextName/);
assert.match(installer, /sensitiveTextExtension/);
assert.match(installer, /\(sensitiveTextExtension\.test\(name\) && sensitiveTextName\.test\(name\)\)/);
for (const reserved of [
  'NODE_ENV',
  'NODE_OPTIONS',
  'HOST',
  'OUTPUT_DIR',
  'DRAWS_DIR',
  'DRAW_ATTEMPTS_FILE',
  'FEEDBACK_FILE',
  'PLAYWRIGHT_BROWSERS_PATH',
  'HOME',
  'XDG_CACHE_HOME',
]) {
  assert.match(installer, new RegExp(`\\b${reserved}\\b`));
}
assert.match(service, /^Environment=WEIBO_BROWSER_SANDBOX=1$/m);
assert.match(service, /^Environment=OUTPUT_DIR=\/opt\/sameko-weibo-lottery\/output$/m);
assert.match(installer, /backup_cleanup_failed=0/);
assert.match(installer, /Preserving service backup:/);
const rollbackIncomplete = installer.indexOf('Rollback was incomplete. Preserving diagnostics:');
assert.ok(rollbackIncomplete >= 0);
const rollbackTail = installer.slice(rollbackIncomplete, installer.indexOf('\n    fi', rollbackIncomplete));
assert.match(rollbackTail, /backup_cleanup_failed=1/);
assert.doesNotMatch(rollbackTail, /backup_dir=''\s*;/);

const appDir = '/opt/sameko-weibo-lottery-v2';
const nodePath = '/usr/local/bin/node';
const rendered = service
  .replaceAll('/opt/sameko-weibo-lottery', appDir)
  .replaceAll('/etc/sameko-weibo-lottery.env', '/etc/sameko-v2.env')
  .replaceAll('/usr/bin/node', nodePath)
  .replace(/^Environment=PORT=.*$/m, 'Environment=PORT=4317');

assert.match(rendered, new RegExp(`WorkingDirectory=${appDir}/current`));
assert.match(rendered, new RegExp(`ExecStart=${nodePath} ${appDir}/current/server\\.mjs`));
assert.match(rendered, new RegExp(`Environment=OUTPUT_DIR=${appDir}/output`));
assert.match(rendered, /^Environment=PORT=4317$/m);
assert.doesNotMatch(rendered, /-v2-v2/);

console.log('DEPLOY_CONTRACT_OK');
