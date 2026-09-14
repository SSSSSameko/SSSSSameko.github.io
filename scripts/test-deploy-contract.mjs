import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [installer, service, caddy, noticeGenerator, notices, staticNotices, legalConfigChecker] = await Promise.all([
  readFile(new URL('../deploy/install.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/sameko-weibo-lottery.service', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/Caddyfile', import.meta.url), 'utf8'),
  readFile(new URL('./generate-third-party-notices.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8'),
  readFile(new URL('../static/third-party-notices.txt', import.meta.url), 'utf8'),
  readFile(new URL('./check-legal-config.mjs', import.meta.url), 'utf8'),
]);

function assertOrdered(source, markers) {
  let cursor = 0;
  for (const marker of markers) {
    const index = source.indexOf(marker, cursor);
    assert.ok(index >= 0, `Expected deployment step after offset ${cursor}: ${marker}`);
    cursor = index + marker.length;
  }
}

async function writeFixturePackage(root, packagePath, name, { license = 'MIT', licenseText = '' } = {}) {
  const directory = path.join(root, packagePath);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', license }), 'utf8');
  if (licenseText) await writeFile(path.join(directory, 'LICENSE'), licenseText, 'utf8');
}

async function verifyNoticeGeneratorContract() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'sameko-license-contract-'));
  const fixtureGenerator = path.join(fixtureRoot, 'scripts', 'generate-third-party-notices.mjs');
  try {
    await mkdir(path.dirname(fixtureGenerator), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'static'), { recursive: true });
    await writeFile(fixtureGenerator, noticeGenerator, 'utf8');
    await writeFile(path.join(fixtureRoot, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/required-package': { version: '1.0.0' },
        'node_modules/optional-installed': { version: '1.0.0', optional: true },
        'node_modules/optional-not-installed': { version: '1.0.0', optional: true },
        'node_modules/optional-platform-specific': { version: '1.0.0', optional: true, os: ['linux'], cpu: ['x64'] },
        'node_modules/rolldown': { version: '1.0.0' },
        'node_modules/@rolldown/binding-contract-test': { version: '1.0.0', optional: true },
      },
    }), 'utf8');
    await writeFixturePackage(fixtureRoot, 'node_modules/required-package', 'required-package', { licenseText: 'required license' });
    await writeFixturePackage(fixtureRoot, 'node_modules/optional-installed', 'optional-installed', { licenseText: 'optional license' });
    await writeFixturePackage(fixtureRoot, 'node_modules/optional-platform-specific', 'optional-platform-specific', { licenseText: 'platform license' });
    await writeFixturePackage(fixtureRoot, 'node_modules/rolldown', 'rolldown', { licenseText: 'rolldown fallback license' });
    await writeFixturePackage(fixtureRoot, 'node_modules/@rolldown/binding-contract-test', '@rolldown/binding-contract-test');

    await execFileAsync(process.execPath, [fixtureGenerator], { cwd: fixtureRoot });
    const generated = await readFile(path.join(fixtureRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(generated, /^# Third-Party Notices for npm Packages Installed in This Release Environment$/m);
    assert.match(generated, /^## required-package 1\.0\.0$/m);
    assert.match(generated, /^## optional-installed 1\.0\.0$/m);
    assert.doesNotMatch(generated, /optional-not-installed/);
    assert.doesNotMatch(generated, /optional-platform-specific/, 'os/cpu restricted optional packages must stay out of the cross-platform notice');
    assert.match(generated, /^## @rolldown\/binding-contract-test 1\.0\.0$/m);
    assert.match(generated, /License text source: `node_modules\/rolldown\/LICENSE`/);
    assert.match(generated, /rolldown fallback license/);

    await rm(path.join(fixtureRoot, 'node_modules', 'required-package'), { recursive: true, force: true });
    await assert.rejects(
      execFileAsync(process.execPath, [fixtureGenerator], { cwd: fixtureRoot }),
      (error) => {
        assert.match(`${error.stdout || ''}\n${error.stderr || ''}`, /node_modules\/required-package: package directory is missing or unreadable/);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function verifyLegalConfigContract() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'sameko-legal-config-contract-'));
  const fixtureChecker = path.join(fixtureRoot, 'check-legal-config.mjs');
  const fixtureConfig = path.join(fixtureRoot, 'config.js');
  try {
    await writeFile(fixtureChecker, legalConfigChecker, 'utf8');
    await writeFile(fixtureConfig, 'window.WEIBO_DRAW_LEGAL = {};\n', 'utf8');
    await assert.rejects(
      execFileAsync(process.execPath, [fixtureChecker, fixtureConfig], { cwd: fixtureRoot }),
      (error) => {
        assert.match(`${error.stdout || ''}\n${error.stderr || ''}`, /Legal release configuration is incomplete/);
        return true;
      },
    );
    await writeFile(fixtureConfig, `window.WEIBO_DRAW_LEGAL = ${JSON.stringify({
      operatorName: '测试运营主体有限公司',
      privacyContact: 'privacy@sameko.test',
      operatorAddress: '中国上海市测试路 1 号',
      hostingProvider: '测试云服务商',
      serverRegion: '中国大陆（上海）',
      dataRecipientDisclosure: '测试云服务商受托提供中国大陆境内托管和存储；测试微博接口服务商处理微博标识及读取请求。',
      recordRetentionDisclosure: '测试部署的开奖记录最多保存 30 天，安全事件最多保存 7 天，期限届满后删除。',
      credentialRetentionDisclosure: '测试账号凭据最长保存 30 天，授权撤回、失效或目的完成时提前删除。',
      backupRetentionDisclosure: '测试备份最多保存 7 天，按覆盖周期自动清除。',
      crossBorderDisclosure: '测试部署不安排境外访问、存储或向境外接收方提供个人信息。',
    })};\n`, 'utf8');
    const valid = await execFileAsync(process.execPath, [fixtureChecker, fixtureConfig], { cwd: fixtureRoot });
    assert.match(valid.stdout, /LEGAL_CONFIG_OK/);
    await writeFile(fixtureConfig, `window.WEIBO_DRAW_LEGAL = ${JSON.stringify({
      operatorName: '张三',
      privacyContact: 'privacy@sameko.test',
    })};\n`, 'utf8');
    const minimal = await execFileAsync(process.execPath, [fixtureChecker, fixtureConfig], { cwd: fixtureRoot });
    assert.match(minimal.stdout, /LEGAL_CONFIG_OK/);
    await writeFile(fixtureConfig, `window.WEIBO_DRAW_LEGAL = ${JSON.stringify({
      privacyContact: 'privacy@sameko.test',
    })};\n`, 'utf8');
    await assert.rejects(
      execFileAsync(process.execPath, [fixtureChecker, fixtureConfig], { cwd: fixtureRoot }),
      (error) => {
        assert.match(`${error.stdout || ''}\n${error.stderr || ''}`, /operatorName.*is required/);
        return true;
      },
    );
    await writeFile(fixtureConfig, `window.WEIBO_DRAW_LEGAL = ${JSON.stringify({
      operatorName: '某某有限公司',
      privacyContact: 'privacy@sameko.test',
      operatorAddress: '某省某市某区某路 1 号',
      hostingProvider: '某某云服务有限公司',
      serverRegion: '中国大陆 · 某地域',
      dataRecipientDisclosure: '测试云服务商受托提供中国大陆境内托管和存储；测试微博接口服务商处理微博标识及读取请求。',
      recordRetentionDisclosure: '测试部署的开奖记录最多保存 30 天，安全事件最多保存 7 天，期限届满后删除。',
      credentialRetentionDisclosure: '测试账号凭据最长保存 30 天，授权撤回、失效或目的完成时提前删除。',
      backupRetentionDisclosure: '测试备份最多保存 7 天，按覆盖周期自动清除。',
      crossBorderDisclosure: '测试部署不安排境外访问、存储或向境外接收方提供个人信息。',
    })};\n`, 'utf8');
    await assert.rejects(
      execFileAsync(process.execPath, [fixtureChecker, fixtureConfig], { cwd: fixtureRoot }),
      (error) => {
        assert.match(`${error.stdout || ''}\n${error.stderr || ''}`, /still appears to contain placeholder text/);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

const servicePort = service.match(/^Environment=PORT=(\d+)$/m)?.[1];
const proxyPort = caddy.match(/reverse_proxy\s+127\.0\.0\.1:(\d+)/)?.[1];
assert.ok(servicePort);
assert.equal(proxyPort, servicePort);
assert.match(caddy, /@blocked_probe/);
assert.match(caddy, /\/\.env\*/);
assert.match(caddy, /\/api\/actuator\*/);
assert.match(caddy, /\/api\/mcp\*/);
assert.match(caddy, /max_header_size\s+16KB/);
assert.match(caddy, /output file \/var\/log\/caddy\/sameko-access\.log/);
assert.match(caddy, /mode\s+0644/);
assert.match(service, /^Environment=EDGE_ACCESS_LOG_PATH=\/var\/log\/caddy\/sameko-access\.log$/m);

const swapCommand = 'mv -Tf -- "${next_link}" "${CURRENT_LINK}"';
const swappedFlag = 'current_swapped=1';
assert.ok(installer.indexOf(swapCommand) >= 0);
assert.ok(installer.indexOf(swappedFlag, installer.indexOf(swapCommand)) > installer.indexOf(swapCommand));
assert.match(installer, /Environment=PORT=\.\*\|Environment=PORT=\$\{health_port\}/);
assert.doesNotMatch(installer, /current_link_replacement/);

for (const asset of ['admin.html', 'admin.css', 'admin.js', 'admin-list-state.js']) {
  assert.match(installer, new RegExp(`server-admin/${asset.replace('.', '\\.')}\\b`));
}
assert.match(installer, /src\/lib\/apiResponse\.js\b/);
assert.match(installer, /src\/lib\/adminStatus\.js\b/);
assert.match(installer, /src\/lib\/diagnostics\.js\b/);
assert.match(installer, /request\(`\$\{adminBase\}\/admin-status\.js`\)/);
assert.match(installer, /request\(`\$\{adminBase\}\/diagnostics\.js`\)/);
assert.match(installer, /ADMIN_BASE_PATH/);
assert.match(installer, /admin_base_path/);

assert.match(installer, /SAMEKO_BROWSER_SOAK_ROUNDS=([2-8])/);
assert.match(installer, /WEIBO_BROWSER_SANDBOX="\$\{weibo_browser_sandbox\}"/);
assert.match(installer, /timeout --signal=TERM --kill-after=10s 10m runuser -u www-data/);
assert.match(installer, /wait_for_service_health "\$\{previous_current\}" 15 0/);
assert.match(installer, /local verify_release_assets="\$\{2:-1\}"/);
assert.match(installer, /git -C "\$\{source_root\}" archive --format=tar "\$\{source_revision\}" \| tar -xf -/);
assert.match(installer, /Refusing to deploy a dirty Git working tree/);
assert.match(installer, /ALLOW_UNVERSIONED_SOURCE=1/);
assert.match(installer, /^ALLOW_PUBLIC_API=1$/m);
assert.doesNotMatch(installer, /API_KEY=\$\(openssl rand -hex 32\)/);
assert.match(installer, /API_KEY is required unless ALLOW_PUBLIC_API=1/);
assert.match(installer, /ADMIN_KEY must be at least 32 bytes when configured/);
assert.match(installer, />"\$\{stage_dir\}\/\.release-commit"/);
assert.match(installer, /soak_tmp_dir="\$\(mktemp -d/);
assert.match(installer, /TMPDIR="\$\{soak_tmp_dir\}"/);
const stageStart = installer.indexOf('  npm ci');
const stageEnd = installer.indexOf('\n)\n\nfor item', stageStart);
assert.ok(stageStart >= 0 && stageEnd > stageStart);
assert.ok(installer.indexOf('node scripts/check-legal-config.mjs static/config.js') < stageStart);
const stageBlock = installer.slice(stageStart, stageEnd);
assertOrdered(stageBlock, [
  'npm ci',
  'export PLAYWRIGHT_BROWSERS_PATH="${stage_dir}/ms-playwright"',
  'npx playwright install --with-deps chromium',
  'find "${PLAYWRIGHT_BROWSERS_PATH}" -type f',
  'npm run licenses',
  'npm run build',
]);
assert.doesNotMatch(stageBlock, /licenses:check/);
assert.match(stageBlock, /-iname 'LICENSE\*'.*-o -iname 'LICENCE\*'.*-o -iname 'COPYING\*'.*-o -iname 'NOTICE\*'/s);
assert.match(stageBlock, /does not establish complete browser-license compliance/);
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

assert.equal(notices, staticNotices);
assert.match(notices, /^# Third-Party Notices for npm Packages Installed in This Release Environment$/m);
assert.match(notices, /Optional npm packages that declare an os\/cpu platform restriction are build-time native binaries/);
assert.doesNotMatch(notices, /^## (?:@rolldown\/binding-|lightningcss-|fsevents )/m);
assert.match(noticeGenerator, /rolldownBindingPattern = \/\^@rolldown\\\/binding-/);
assert.doesNotMatch(noticeGenerator, /if \(locked\.optional === true\) continue/);
await verifyNoticeGeneratorContract();
await verifyLegalConfigContract();

console.log('DEPLOY_CONTRACT_OK');
