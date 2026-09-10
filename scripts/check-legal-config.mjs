import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const configFile = path.resolve(process.argv[2] || 'static/config.js');
const source = await readFile(configFile, 'utf8');
const sandbox = {
  window: {
    location: { hostname: 'release-validation.invalid' },
  },
};
const context = vm.createContext(sandbox, {
  codeGeneration: { strings: false, wasm: false },
});

try {
  new vm.Script(source, { filename: configFile }).runInContext(context, { timeout: 1000 });
} catch (error) {
  console.error(`Unable to evaluate legal configuration: ${error.message}`);
  process.exit(1);
}

const legal = sandbox.window.WEIBO_DRAW_LEGAL;
// PIPL 第 17 条强制告知的只有"处理者名称或者姓名"和"联系方式"两项。
// 地址、托管商、机房区域、备份策略属于可自选披露内容，这里不再强制，填写时才校验。
const requiredFields = {
  operatorName: { label: 'operatorName（运营者名称或姓名）', maxLength: 240 },
  privacyContact: { label: 'privacyContact（有效隐私联系渠道）', maxLength: 240 },
};
const optionalFields = {
  operatorAddress: { label: 'operatorAddress（运营者联系地址）', maxLength: 240 },
  hostingProvider: { label: 'hostingProvider（托管服务商）', maxLength: 240 },
  serverRegion: { label: 'serverRegion（服务器区域）', maxLength: 240 },
  dataRecipientDisclosure: { label: 'dataRecipientDisclosure（接收方与受托处理方披露）', maxLength: 1200 },
  jurisdictionDisclosure: { label: 'jurisdictionDisclosure（适用法律与管辖）', maxLength: 1200 },
  recordRetentionDisclosure: { label: 'recordRetentionDisclosure（服务器记录保存规则）', maxLength: 1200 },
  credentialRetentionDisclosure: { label: 'credentialRetentionDisclosure（服务器登录资料保存规则）', maxLength: 1200 },
  backupRetentionDisclosure: { label: 'backupRetentionDisclosure（备份保存与清除规则）', maxLength: 1200 },
  crossBorderDisclosure: { label: 'crossBorderDisclosure（跨境处理情况）', maxLength: 1200 },
};
const fields = { ...requiredFields, ...optionalFields };
const placeholderPattern = /(?:待填写|待补充|待定|未配置|未公布|未知|占位|示例|某某|某省|某市|某区|某县|某路|某街|某公司|某单位|某地域|unknown|example|placeholder|your[-_ ]|xxx|tbd|todo)/i;
const errors = [];

if (!legal || typeof legal !== 'object' || Array.isArray(legal)) {
  errors.push('window.WEIBO_DRAW_LEGAL must be an object.');
} else {
  for (const [key, { label, maxLength }] of Object.entries(fields)) {
    const value = String(legal[key] || '').trim();
    if (!value) {
      if (key in requiredFields) errors.push(`${label} is required.`);
      continue;
    }
    if (value.length > maxLength) errors.push(`${label} must not exceed ${maxLength} characters.`);
    if (/[\u0000-\u001F\u007F]/.test(value)) errors.push(`${label} contains control characters.`);
    if (placeholderPattern.test(value)) errors.push(`${label} still appears to contain placeholder text.`);
  }
}

if (errors.length) {
  console.error('Legal release configuration is incomplete:');
  for (const error of errors) console.error(`- ${error}`);
  console.error('Public deployment is blocked until the operator supplies a real operator name and a working privacy contact.');
  process.exit(1);
}

console.log('LEGAL_CONFIG_OK');
