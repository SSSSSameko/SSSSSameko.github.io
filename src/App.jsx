import React, { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArchiveRestore,
  BadgeCheck,
  BookOpen,
  ChevronRight,
  CheckCircle2,
  ClipboardCopy,
  Clock,
  Download,
  Ellipsis,
  FileText,
  Gift,
  History,
  Info,
  Link2,
  ListChecks,
  MessageSquareHeart,
  Minus,
  Plus,
  RefreshCw,
  Settings,
  Send,
  ShieldCheck,
  Sparkles,
  Shuffle,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import {
  buildFilterSummary,
  candidateCutoffInfo,
  candidateLoadWarning,
  cleanApiBase,
  digestCandidates,
  friendlyProviderText,
  MAX_MANUAL_CANDIDATES,
  MAX_MANUAL_FILE_BYTES,
  normalizeMentionMin,
  parseManualInput,
  randomSeedHex,
  readStoredValue,
  seededShuffle,
  toCsv,
  writeStoredValue,
} from './lib/appCore.js';
import CandidateAvatar from './components/CandidateAvatar.jsx';
import DrawResultSheet from './components/DrawResultSheet.jsx';
import { avatarProxyUrl, safeAvatarUrl } from './lib/avatar.js';
import useDialogStack from './hooks/useDialogStack.js';
import useSheetDrag from './hooks/useSheetDrag.js';
import {
  cancelDrawDeckMotion,
  settleDrawDeckMotion,
  startDrawDeckMotion,
} from './lib/drawDeckMotion.js';
import {
  buildFairnessSummary,
  DRAW_HISTORY_LIMIT,
  drawCountCopy,
  mergeDrawHistory,
  nextManualDrawNumber,
  normalizeDrawReceipt,
  parseDrawHistoryBackup,
  readDrawHistory,
  receiptWinnerRows,
  receiptWinnerText,
  serializeDrawHistoryBackup,
  upsertDrawReceipt,
  winnerIdsForStatus,
  writeDrawHistory,
} from './lib/drawReceipts.js';
import {
  acquireDrawGuard,
  acquireDrawTabLock,
  completeDrawGuard,
  drawCooldownScope,
  drawCooldownStatus,
  releaseDrawGuard,
} from './lib/drawCooldown.js';
import {
  candidateIdentity,
  eligibleCandidates,
  evaluateCandidateEligibility,
  summarizeCandidateEligibility,
} from './lib/candidateEligibility.js';
import { buildAnnouncementText } from './lib/drawAnnouncements.js';
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MAX_LENGTH,
  normalizeFeedbackSubmission,
} from './lib/feedback.js';
import { isWeiboStatusReference } from './lib/weiboStatus.js';
import { isResponseBodyTimeout, readResponseTextWithin } from './lib/apiResponse.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  let timer;
  const finish = () => {
    signal?.removeEventListener('abort', cancel);
    resolve();
  };
  const cancel = () => {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    reject(new DOMException('操作已取消', 'AbortError'));
  };
  timer = window.setTimeout(finish, ms);
  if (!signal) return;
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
});
const throwIfAborted = (signal) => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('操作已取消', 'AbortError');
};
const publicAsset = (name) => `${import.meta.env.BASE_URL}${name}`;
const APP_VERSION = '3.2.0';
const REPOST_JOB_TIMEOUT_MS = 90 * 60 * 1000;
const REPOST_JOB_POLL_MS = 1200;
const REPOST_JOB_RECONNECT_ATTEMPTS = 4;
const REPOST_JOB_RECONNECT_BASE_MS = 900;
const API_FETCH_TIMEOUT_MS = 45_000;
const CANDIDATE_BATCH_SIZE = 100;
const CANDIDATE_RENDER_LIMIT = 1000;
const MAX_DRAW_WINNERS = 500;
const MAX_DRAW_RESULT_GROUPS = 20;
const MAX_HISTORY_BACKUP_BYTES = 2 * 1024 * 1024;
const API_RESPONSE_MAX_BYTES = 24 * 1024 * 1024;
const apiResponseLifecycles = new WeakMap();

function byteLength(value) {
  const text = String(value || '');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
  return new Blob([text]).size;
}

async function warmDrawAvatars(candidates, apiBase, signal) {
  if (typeof window.Image !== 'function') return;
  const urls = [...new Set(candidates
    .map((candidate) => avatarProxyUrl(safeAvatarUrl(candidate?.avatar), apiBase))
    .filter(Boolean))]
    .slice(0, 18);
  if (!urls.length) return;

  const loads = urls.map((url) => new Promise((resolve) => {
    const image = new window.Image();
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      image.src = '';
      done();
    };
    const timer = window.setTimeout(done, 1500);
    image.decoding = 'async';
    image.onload = done;
    image.onerror = done;
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    image.src = url;
  }));
  await Promise.race([
    Promise.allSettled(loads),
    sleep(650, signal),
  ]);
}

const historyDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const candidateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function looksLikeWeiboStatusReference(value) {
  return isWeiboStatusReference(value);
}
function configuredApiBases() {
  const configured = [
    window.WEIBO_DRAW_API_BASE,
    ...(Array.isArray(window.WEIBO_DRAW_ALLOWED_API_BASES) ? window.WEIBO_DRAW_ALLOWED_API_BASES : []),
  ];
  return [...new Set(configured.map(cleanApiBase).filter(Boolean))];
}
function isLocalApiBase(value) {
  try {
    const url = new URL(cleanApiBase(value));
    return ['http:', 'https:'].includes(url.protocol)
      && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
  } catch {
    return false;
  }
}
function isTrustedApiBase(value) {
  const cleaned = cleanApiBase(value);
  if (!cleaned) return true;
  try {
    const url = new URL(cleaned);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (isLocalApiBase(cleaned)) return true;
    return configuredApiBases().includes(cleaned);
  } catch {
    return false;
  }
}
function initialApiBase() {
  const storedApi = cleanApiBase(readStoredValue('weibo-draw-api-base'));
  if (storedApi && isTrustedApiBase(storedApi)) return storedApi;
  if (storedApi) writeStoredValue('weibo-draw-api-base', '');
  return cleanApiBase(window.WEIBO_DRAW_API_BASE || '');
}
function isStaticHostedPage() {
  return /\.github\.io$/i.test(location.hostname) || location.protocol === 'file:';
}

async function readApiResponse(response, label = '服务') {
  const lifecycle = apiResponseLifecycles.get(response);
  let text;
  try {
    text = await readResponseTextWithin(response, {
      timeoutMs: API_FETCH_TIMEOUT_MS,
      maxBytes: API_RESPONSE_MAX_BYTES,
      signal: lifecycle?.signal,
    });
  } catch (error) {
    if (lifecycle?.timedOut() || isResponseBodyTimeout(error)) {
      throw new Error(`${label}响应超时，请稍后重试。`);
    }
    throw error;
  } finally {
    lifecycle?.cleanup();
    apiResponseLifecycles.delete(response);
  }
  if (!text.trim()) {
    throw new Error(`${label}暂时不可用（HTTP ${response.status}），请检查后端连接后重试。`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}返回格式异常（HTTP ${response.status}），请稍后重试。`);
  }
}

function download(name, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  downloadUrl(name, url);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadUrl(name, url) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
function canvasBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('图片编码失败'));
    }, type);
  });
}
const COLORS = ['#4f9fff', '#54c6a8', '#e6ad61', '#8f93f5', '#9bd7ff', '#ee8fa1'];
const PRIZE_NAMES = ['一等奖', '二等奖', '三等奖', '幸运奖'];
function defaultPrize(index = 0, count = 1) {
  return {
    name: PRIZE_NAMES[index] || `奖项${index + 1}`,
    count,
    color: COLORS[index % COLORS.length],
  };
}
const DEFAULT_PRIZES = [defaultPrize(0, 1)];

const SOURCE_OPTIONS = [
  { value: 'mobile', label: '微博链接' },
  { value: 'manual', label: '手动名单' },
  { value: 'official', label: '官方接口' },
];
const MOTION_OPTIONS = [
  { value: 'full', label: '完整' },
  { value: 'system', label: '跟随系统' },
  { value: 'reduced', label: '减少' },
];

function initialMotionPreference() {
  const stored = readStoredValue('weibo-draw-motion');
  return MOTION_OPTIONS.some((option) => option.value === stored) ? stored : 'system';
}

function canUseLocalStorage() {
  const key = 'weibo-draw-storage-check';
  try {
    window.localStorage.setItem(key, key);
    const stored = window.localStorage.getItem(key) === key;
    window.localStorage.removeItem(key);
    return stored;
  } catch {
    try {
      window.localStorage.removeItem(key);
    } catch {
    }
    return false;
  }
}

function shouldReduceMotion(preference) {
  if (preference === 'full') return false;
  if (preference === 'reduced') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function shortLoadedTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function historyDateParts(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return { month: '--', day: '--', time: '暂无', compact: '--' };
  const parts = Object.fromEntries(
    historyDateFormatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    month: parts.month || '--',
    day: parts.day || '--',
    time: `${parts.hour || '--'}:${parts.minute || '--'}`,
    compact: `${parts.month || '--'}.${parts.day || '--'}`,
  };
}

function formattedCandidateTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  return candidateTimeFormatter.format(date).replaceAll('/', '-');
}

const GUIDE_STEPS = [
  ['1', '载入候选', '粘贴微博正文链接、mid 或 bid。应用优先使用服务器登录态，不可用时再尝试备用 Cookie。'],
  ['2', '核对名单', '确认候选人数和筛选结果。你也可以手动填写名单，或导入 CSV、TXT、TSV 和 JSON 文件。'],
  ['3', '确认抽奖设置', '检查奖项顺序、中奖人数和筛选规则。中奖总人数不能超过可抽人数。'],
  ['4', '核对并开奖', '在开奖确认页核对候选、奖项和历史次数，再开始抽取。完成后可保存结果图或复制公示文案。'],
];

const UPDATE_LOGS = [
  {
    version: '3.2.0',
    date: '2026 年 8 月 31 日',
    label: '当前版本',
    title: '完善名单工具与运行稳定性',
    items: [
      '候选名单新增搜索、详情查看和当前名单导出',
      '开奖记录支持备份恢复，结果可复制、导出或保存图片',
      '优化候选载入、任务取消、弹窗动效和大名单操作',
    ],
  },
  {
    version: '3.1.0',
    date: '2026 年 8 月 25 日',
    label: '历史版本',
    title: '优化开奖体验',
    items: [
      '优化界面与开奖结果',
      '增加开奖前确认',
      '提升运行稳定性',
    ],
  },
  {
    version: '3.0.0',
    date: '2026 年 8 月 23 日',
    label: '历史版本',
    title: '重构主要使用流程',
    items: [
      '优化候选载入、错误提示、开奖结果和开奖记录',
      '统一抽奖、名单、记录与更多页面的界面和交互',
      '修复 JSON 名单导入时昵称被拆开的问题',
      '增加意见反馈功能',
    ],
  },
  {
    version: '2.1.0',
    date: '2026 年 7 月 25 日',
    label: '历史版本',
    title: '完善开奖展示',
    items: [
      '优化洗牌动画、结果图片和微博公示文案',
      '支持显示真实微博头像',
      '优化昵称、UID、奖项和获奖名单排版',
    ],
  },
  {
    version: '2.0.0',
    date: '2026 年 7 月 24 日',
    label: '历史版本',
    title: '重新设计移动端抽奖界面',
    items: [
      '使用底部标签栏重组抽奖、名单、记录和更多页面',
      '增加本链接开奖次数和完整开奖结果弹窗',
      '优化开奖记录展示和移动端操作流程',
    ],
  },
  {
    version: '1.2.0',
    date: '2026 年 7 月 2 日',
    label: '历史版本',
    title: '优化云端运行',
    items: [
      '增加微博 Cookie 自动保活和状态记录',
      '优化服务器状态、任务处理和后台运行信息',
      '改进低配置服务器的运行稳定性',
    ],
  },
  {
    version: '1.1.2',
    date: '2026 年 6 月 4 日',
    label: '历史版本',
    title: '完善候选抓取与后台管理',
    items: [
      '支持用户无需登录微博直接载入候选',
      '增加后台管理、任务队列、抓取进度和并发限制',
      '完善公开部署、异常处理和基础安全保护',
    ],
  },
  {
    version: '1.0.1',
    date: '2026 年 5 月 29 日',
    label: '历史版本',
    title: '上线微博转发抽奖',
    items: [
      '支持通过微博链接获取公开可见的转发用户',
      '支持手动名单、微博 H5 和官方接口等候选来源',
      '增加结果图片、CSV 导出和云端开奖记录',
    ],
  },
  {
    version: '0.0.1',
    date: '2026 年 5 月 22 日',
    label: '历史版本',
    title: '建立基础抽奖流程',
    items: [
      '支持粘贴或导入候选名单',
      '支持名单去重、关键词筛选和排除名单',
      '增加多奖项、候补、随机种子、开奖记录和结果导出',
    ],
  },
];

const LEGAL_DOCUMENTS = {
  about: {
    key: 'about',
    title: '关于此应用',
    subtitle: `版本 ${APP_VERSION} · by.sameko`,
    sections: [
      ['用途', '用于整理微博转发候选、设置筛选与奖项、随机抽取并保存开奖记录。'],
      ['数据范围', '微博候选以载入时当前登录态及微博接口可见的转发数据为准。手动名单由活动主办方自行核对。'],
      ['服务关系', '本应用由独立开发者维护，与微博官方无隶属、赞助或背书关系。'],
    ],
  },
  updates: {
    key: 'updates',
    title: '更新日志',
    subtitle: '当前版本与历史正式版本',
    updates: UPDATE_LOGS,
  },
  disclaimer: {
    key: 'disclaimer',
    title: '免责声明',
    subtitle: '服务边界与使用责任',
    sections: [
      ['候选数据', '候选名单取决于载入时当前登录态及微博接口可见的数据和筛选规则。不可见转发、平台限制、网络异常和账号权限可能影响名单完整性。'],
      ['开奖结果', '本应用使用带随机种子的 Fisher-Yates 洗牌生成结果，并保存名单摘要和过程哈希。相关记录用于复查本次流程，不代表微博或其他第三方认证，也不是不可伪造的服务端证明。'],
      ['筛选范围', '“排除已中奖用户”只针对当前浏览器中的当前任务和已保存本机记录，不代表跨设备、跨用户或跨活动的全局限制。'],
      ['主办方责任', '活动主办方应在开奖前核对候选、奖项和筛选规则，并负责活动规则、结果公示、奖品发放、税费及其他法定义务。'],
      ['账号安全', '服务器登录态不可用时才会尝试备用 Cookie。请只使用本人有权使用的 Cookie，不要在公共设备或他人可访问的页面中填写。'],
      ['服务可用性', '平台接口调整、网络故障、服务器维护或不可抗力可能导致服务中断、数据不完整或记录保存失败。请在公示前下载结果并核对保存状态。'],
      ['法律说明', '本说明介绍工具边界，不构成法律意见。活动合规要求请咨询具有相应资质的专业人士。'],
    ],
  },
  privacy: {
    key: 'privacy',
    title: '隐私政策',
    subtitle: '候选、Cookie 与记录如何处理',
    sections: [
      ['运营者与联系渠道', '个人信息处理者为 by.sameko。如需查询或申请删除服务器数据，请在“意见反馈”中选择“隐私与数据”，并提供对应的过程哈希。'],
      ['处理目的', '本应用处理候选数据，用于载入转发名单、应用筛选规则、完成抽奖和生成开奖记录。'],
      ['处理的数据', '处理内容包括微博链接、当前登录态及接口可见的转发信息、筛选条件、奖项和结果。候选信息可能包含昵称、UID、头像地址、转发文本和时间。'],
      ['备用 Cookie', '应用优先使用服务器登录态，仅在其不可用时尝试你填写的备用 Cookie。该内容会发送至本应用服务器并仅在当前任务内存中处理，任务结束后立即清除，不写入服务器 Cookie 池或浏览器长期存储。'],
      ['官方访问令牌', '选择官方接口时，访问令牌会发送至本应用服务器并仅用于当前载入任务，任务结束后立即清除。请只使用通过微博官方授权获得且有权使用的令牌。'],
      ['浏览器存储', '浏览器保存最近开奖记录、界面动效偏好和可信的后端地址。候选、奖项、筛选条件、访问密钥和 Cookie 会在刷新页面后清除。'],
      ['短期任务数据', '抓取任务和候选快照只保存在服务器内存中。排队最长等待 5 分钟，运行最长 85 分钟；任务结束后通常在 1 分钟内清除，相同条件的候选快照最多复用 15 秒。'],
      ['服务器记录', '开奖完成后，服务器保存微博标识、候选统计、名单摘要、筛选规则、随机过程和必要的获奖信息，用于统计开奖次数和复查记录，最长保存 180 天。服务器 Cookie 由站长单独管理。'],
      ['意见反馈', '提交反馈时，服务器保存分类、正文、提交时间和由网络地址生成的去标识化来源标识，最长保存 90 天。反馈不收集联系方式，也不提供站内回复。'],
      ['公开与分享', '保存结果图或复制公示文案前，请确认你有权公开获奖者昵称、UID、头像及其他相关信息。'],
      ['删除与控制', '你可以在“数据设置”中清空当前数据、备用 Cookie 和本机开奖记录。申请删除服务器开奖记录或反馈时，请通过“隐私与数据”反馈提交过程哈希或反馈编号，站长核对后处理。'],
      ['生效日期', '本政策自 2026 年 8 月 25 日起生效。处理方式或保存期限发生变化时，本页面会同步更新。'],
    ],
  },
  terms: {
    key: 'terms',
    title: '用户协议',
    subtitle: '使用规则与禁止事项',
    sections: [
      ['使用条件', '请在法律法规、微博平台规则和活动规则允许的范围内使用本应用，并确保活动与奖品安排真实、可履行。'],
      ['账号授权', '只能填写你有权使用的 Cookie 或访问令牌。不得盗用账号、绕过平台安全措施或干扰微博服务。'],
      ['平台规则', '应优先使用微博官方授权方式。备用 Cookie 仅用于服务器登录态失效时的当前任务，使用者应自行确认账号授权范围和微博平台规则。'],
      ['数据使用', '不得非法收集、出售、披露或滥用候选信息，也不得使用本应用批量骚扰他人。'],
      ['活动限制', '不得将本应用用于收费参与、赌博、非法彩票、虚假奖品或其他违法活动。活动规则、奖品数量、兑奖期限和参与条件应真实、明确且可履行。'],
      ['未成年人', '活动涉及未成年人参与或不满十四周岁未成年人信息时，主办方应依法取得监护人同意并采取必要保护措施。'],
      ['开奖诚信', '不得篡改候选名单、筛选规则、随机记录或开奖结果，不得使用本应用制造虚假公示。'],
      ['开奖确认', '点击“确认并开始抽奖”表示你已核对候选范围、筛选条件、奖项顺序和名额。随机种子、名单摘要和过程哈希用于复查，不代表第三方认证。'],
      ['结果履行', '活动主办方负责联系获奖者、核验资格、发放奖品并处理活动争议。'],
    ],
  },
  copyright: {
    key: 'copyright',
    title: '版权说明',
    subtitle: '应用、用户与平台内容',
    sections: [
      ['应用内容', '除开源组件及另有说明的内容外，本应用的界面、文字与程序代码由相应权利人保留权利。'],
      ['源代码', '代码可公开查看不等于自动授予复制、修改或分发许可。自有代码的使用以仓库根目录 LICENSE 文件为准。'],
      ['用户与平台内容', '微博昵称、头像、转发内容和活动素材的权利归原权利人所有。本工具仅为完成抽奖流程而展示和处理这些信息。'],
      ['商标', '“微博”及相关标识属于其权利人。本工具为独立辅助工具，不代表微博官方提供、赞助或背书。'],
    ],
  },
  licenses: {
    key: 'licenses',
    title: '第三方许可',
    subtitle: '所用软件与完整许可文本',
    sections: [
      ['主要组件', '包括 React、React DOM、Lucide React、Vite、PostCSS、Autoprefixer 和 Playwright，以及其必要依赖。'],
      ['许可范围', '各第三方组件分别适用 MIT、ISC、Apache 2.0、BSD、MPL、CC BY 等许可证，具体以完整清单中的版权和许可文本为准。'],
      ['自有代码', '除第三方组件及另有说明的内容外，本项目自有代码保留全部权利。'],
    ],
    noticeHref: publicAsset('third-party-notices.txt'),
  },
};

const I = {
  users: <Users className="icon-18" strokeWidth={1.5} />,
  listChecks: <ListChecks className="icon-18" strokeWidth={1.65} />,
  book: <BookOpen className="icon-18" strokeWidth={1.7} />,
  chevron: <ChevronRight className="icon-16" strokeWidth={1.8} />,
  alert: <AlertCircle className="icon-18" strokeWidth={1.9} />,
  check: <CheckCircle2 className="icon-18" strokeWidth={1.9} />,
  file: <FileText className="icon-18" strokeWidth={1.7} />,
  link: <Link2 className="icon-18" strokeWidth={1.8} />,
  gift: <Gift className="icon-18" strokeWidth={1.5} />,
  badgeCheck: <BadgeCheck className="icon-18" strokeWidth={1.65} />,
  clock: <Clock className="icon-18" strokeWidth={1.5} />,
  history: <History className="icon-18" strokeWidth={1.65} />,
  refresh: <RefreshCw className="icon-16" strokeWidth={1.8} />,
  shuffle: <Shuffle className="icon-20" strokeWidth={2} />,
  trash: <Trash2 className="icon-16" strokeWidth={1.8} />,
  settings: <Settings className="icon-18" strokeWidth={1.5} />,
  sparkles: <Sparkles className="icon-18" strokeWidth={1.7} />,
  close: <X className="icon-16" strokeWidth={2} />,
  plus: <Plus className="icon-16" strokeWidth={2} />,
  minus: <Minus className="icon-16" strokeWidth={2} />,
  upload: <Upload className="icon-16" strokeWidth={1.8} />,
  shield: <ShieldCheck className="icon-16" strokeWidth={1.7} />,
  download: <Download className="icon-16" strokeWidth={1.8} />,
  more: <Ellipsis className="icon-19" strokeWidth={1.8} />,
  info: <Info className="icon-18" strokeWidth={1.8} />,
  feedback: <MessageSquareHeart className="icon-18" strokeWidth={1.65} />,
  send: <Send className="icon-16" strokeWidth={1.8} />,
  copy: <ClipboardCopy className="icon-16" strokeWidth={1.8} />,
  archive: <ArchiveRestore className="icon-18" strokeWidth={1.65} />,
};

function keepFocusInDialog(event, dialog) {
  if (event.key !== 'Tab' || !dialog) return;
  const controls = [...dialog.querySelectorAll(
    'a[href], summary, button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getClientRects().length);
  if (!controls.length) return;
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function ErrorNoticeDialog({ notice, onClose }) {
  const dialogRef = useRef(null);
  const actionRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef(null);
  const previousNoticeIdRef = useRef(null);
  const isTopDialog = useDialogStack(Boolean(notice), 100);
  onCloseRef.current = onClose;
  if (previousNoticeIdRef.current !== notice.id) {
    previousNoticeIdRef.current = notice.id;
    previousFocusRef.current = document.activeElement;
  }

  function dismiss() {
    onCloseRef.current();
    window.setTimeout(() => {
      const fallback = [...document.querySelectorAll(
        '.receipt-backdrop .receipt-close, .flow-sheet-backdrop .flow-sheet-close',
      )].find((element) => element.getClientRects().length && !element.closest('.is-closing'));
      fallback?.focus?.({ preventScroll: true });
    }, 0);
  }

  useEffect(() => {
    actionRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (!isTopDialog()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismiss();
      }
      keepFocusInDialog(event, dialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      const previousFocus = previousFocusRef.current;
      const previousIsUsable = previousFocus
        && document.contains(previousFocus)
        && !previousFocus.closest('[inert]');
      if (previousIsUsable) {
        previousFocus.focus?.({ preventScroll: true });
        return;
      }
      window.setTimeout(() => {
        const fallback = [...document.querySelectorAll(
          '.receipt-backdrop:not([inert]) .receipt-close, .flow-sheet-backdrop:not([inert]) .flow-sheet-close',
        )].find((element) => element.getClientRects().length);
        fallback?.focus?.({ preventScroll: true });
      }, 0);
    };
  }, [isTopDialog, notice.id]);

  return (
    <div className="v3-alert-backdrop" role="presentation" onClick={dismiss}>
      <section ref={dialogRef} className="v3-alert-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`notice-${notice.id}`} aria-describedby={`notice-message-${notice.id}`} onClick={(event) => event.stopPropagation()}>
        <span className="v3-alert-icon">{I.alert}</span>
        <h2 id={`notice-${notice.id}`}>{notice.title}</h2>
        <p id={`notice-message-${notice.id}`}>{notice.message}</p>
        <button ref={actionRef} type="button" onClick={dismiss}>知道了</button>
      </section>
    </div>
  );
}

function CandidateLoadProgress({ progress, isLoading, onCancel }) {
  const percent = Math.round(Math.max(0, Math.min(100, Number(progress?.percent) || 0)));
  const message = progress?.message || '正在处理';
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (!progress) return undefined;
    const timer = window.setTimeout(() => {
      setAnnouncement(`${message}，${percent}%`);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [message, percent, Boolean(progress)]);

  if (!progress) return null;
  return (
    <div className="v3-progress">
      <div className="v3-progress-copy">
        <span>{message}</span>
        <strong>{percent}%</strong>
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      {isLoading && (
        <button type="button" onClick={onCancel}>取消载入</button>
      )}
      <div
        className="v3-progress-track"
        role="progressbar"
        aria-label="候选载入进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${message}，${percent}%`}
      >
        <i style={{ '--progress-scale': percent / 100 }} />
      </div>
    </div>
  );
}

function NoticeToast({ notice, onClose }) {
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    setIsClosing(false);
    if (!notice || notice.tone === 'error') return undefined;
    const dismissTimer = window.setTimeout(() => setIsClosing(true), 2800);
    const closeTimer = window.setTimeout(onClose, 2980);
    return () => {
      window.clearTimeout(dismissTimer);
      window.clearTimeout(closeTimer);
    };
  }, [notice?.id]);

  if (!notice) return null;
  if (notice.tone === 'error') return <ErrorNoticeDialog notice={notice} onClose={onClose} />;
  const icon = notice.tone === 'success' ? I.check : I.alert;
  return (
    <div className={`flow-notice flow-notice-${notice.tone || 'neutral'} ${isClosing ? 'is-closing' : ''}`}>
      <span className="flow-notice-icon">{icon}</span>
      <div>
        <strong>{notice.title}</strong>
        <p>{notice.message}</p>
      </div>
      <button type="button" aria-label="关闭提示" onClick={onClose}>{I.close}</button>
    </div>
  );
}

function ConfirmActionDialog({ action, motionPreference, onClose, onConfirm }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const timerRef = useRef(null);
  const closingRef = useRef(false);
  const [isClosing, setIsClosing] = useState(false);
  const isTopDialog = useDialogStack(Boolean(action));

  function close(afterClose) {
    if (closingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
    timerRef.current = window.setTimeout(() => {
      onClose();
      afterClose?.();
    }, shouldReduceMotion(motionPreference) ? 1 : 160);
  }

  useEffect(() => {
    const previousFocus = document.activeElement;
    cancelRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (!isTopDialog()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
      keepFocusInDialog(event, dialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.clearTimeout(timerRef.current);
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, [isTopDialog]);

  return (
    <div className={`v3-alert-backdrop ${isClosing ? 'is-closing' : ''}`} role="presentation" onClick={() => close()}>
      <section ref={dialogRef} className="v3-alert-dialog v3-confirm-action-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`confirm-${action.kind}`} aria-describedby={`confirm-message-${action.kind}`} onClick={(event) => event.stopPropagation()}>
        <span className="v3-alert-icon">{I.trash}</span>
        <h2 id={`confirm-${action.kind}`}>{action.title}</h2>
        <p id={`confirm-message-${action.kind}`}>{action.message}</p>
        <div className="v3-confirm-action-buttons">
          <button ref={cancelRef} type="button" onClick={() => close()}>取消</button>
          <button className="is-destructive" type="button" onClick={() => close(onConfirm)}>{action.confirmLabel || '清空'}</button>
        </div>
      </section>
    </div>
  );
}

function SheetFrame({
  title,
  subtitle,
  icon,
  onClose,
  children,
  className = '',
  initialFocusRef = null,
  returnFocusId = '',
}) {
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const closeTimerRef = useRef(null);
  const requestCloseRef = useRef(null);
  const closingRef = useRef(false);
  const [isClosing, setIsClosing] = useState(false);
  const isTopDialog = useDialogStack(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  function requestClose(afterClose, { immediate = false } = {}) {
    if (closingRef.current) return;
    closingRef.current = true;
    if (immediate) {
      onCloseRef.current?.();
      afterClose?.();
      return;
    }
    setIsClosing(true);
    const shellMotion = dialogRef.current?.closest('.app-shell')?.dataset.motion;
    const reduceMotion = shellMotion === 'reduced'
      || (shellMotion !== 'full' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    closeTimerRef.current = window.setTimeout(() => {
      onCloseRef.current?.();
      afterClose?.();
    }, reduceMotion ? 1 : 190);
  }
  requestCloseRef.current = requestClose;
  const sheetDrag = useSheetDrag({
    sheetRef: dialogRef,
    backdropRef,
    onDismiss: () => requestCloseRef.current?.(undefined, { immediate: true }),
  });

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const scrollContainer = document.querySelector('.root-view.is-active .root-scroll');
    const previousScrollTop = scrollContainer?.scrollTop;
    document.body.style.overflow = 'hidden';
    const initialFocus = initialFocusRef?.current;
    const focusTarget = initialFocus?.getClientRects().length ? initialFocus : closeButtonRef.current;
    focusTarget?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (!isTopDialog()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        requestCloseRef.current?.();
      }
      keepFocusInDialog(event, dialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      window.clearTimeout(closeTimerRef.current);
      if (scrollContainer?.isConnected && Number.isFinite(previousScrollTop)) {
        scrollContainer.scrollTop = previousScrollTop;
      }
      window.requestAnimationFrame(() => {
        const preferredFocus = returnFocusId ? document.getElementById(returnFocusId) : null;
        if (preferredFocus?.isConnected && preferredFocus.getClientRects().length) {
          preferredFocus.focus({ preventScroll: true });
          return;
        }
        const wasInteractive = previousFocus?.matches?.(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        );
        if (wasInteractive && previousFocus.isConnected && previousFocus.getClientRects().length) {
          previousFocus.focus({ preventScroll: true });
          return;
        }
      });
    };
  }, [initialFocusRef, isTopDialog, returnFocusId]);

  return (
    <div ref={backdropRef} className={`flow-sheet-backdrop ${isClosing ? 'is-closing' : ''}`} onClick={() => requestClose()}>
      <div ref={dialogRef} className={`flow-sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="flow-sheet-grabber" aria-hidden="true" {...sheetDrag} />
        <div className="flow-sheet-head">
          <div className="flow-sheet-title">
            <span>{icon}</span>
            <div>
              <h2>{title}</h2>
              {subtitle && <p>{subtitle}</p>}
            </div>
          </div>
          <button ref={closeButtonRef} type="button" aria-label={`关闭${title}`} onClick={() => requestClose()} className="flow-sheet-close">{I.close}</button>
        </div>
        <div className="flow-sheet-body">
          {typeof children === 'function' ? children(requestClose) : children}
        </div>
      </div>
    </div>
  );
}

function FilterEditorSheet({ controller, onClose }) {
  const [draft, setDraft] = useState(() => ({
    keyword: controller.keyword,
    mentionMin: controller.mentionMin,
    blocklist: controller.blocklist,
    uniqueByUser: controller.uniqueByUser,
    excludePrevious: controller.excludePrevious,
  }));

  const updateDraft = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const setPreset = (keyword, mentionMin) => updateDraft({ keyword, mentionMin });

  return (
    <SheetFrame title="筛选规则" subtitle="调整本轮可抽候选" icon={I.listChecks} onClose={onClose} className="v3-editor-sheet">
      {(close) => (
        <>
          <div className="v3-filter-presets">
            <button
              type="button"
              className={!draft.keyword && Number(draft.mentionMin) === 0 ? 'is-active' : ''}
              aria-pressed={!draft.keyword && Number(draft.mentionMin) === 0}
              onClick={() => setPreset('', 0)}
            >
              不限内容
            </button>
            <button
              type="button"
              className={draft.keyword === '抽奖' && Number(draft.mentionMin) === 0 ? 'is-active' : ''}
              aria-pressed={draft.keyword === '抽奖' && Number(draft.mentionMin) === 0}
              onClick={() => setPreset('抽奖', 0)}
            >
              含“抽奖”
            </button>
            <button
              type="button"
              className={!draft.keyword && Number(draft.mentionMin) === 1 ? 'is-active' : ''}
              aria-pressed={!draft.keyword && Number(draft.mentionMin) === 1}
              onClick={() => setPreset('', 1)}
            >
              至少 @1
            </button>
            <button
              type="button"
              className={!draft.keyword && Number(draft.mentionMin) === 2 ? 'is-active' : ''}
              aria-pressed={!draft.keyword && Number(draft.mentionMin) === 2}
              onClick={() => setPreset('', 2)}
            >
              至少 @2
            </button>
          </div>
          <div className="v3-form-group">
            <label><span>转发关键词</span><input value={draft.keyword} onChange={(event) => updateDraft({ keyword: event.target.value })} placeholder="留空表示不限" /></label>
            <label><span>至少 @ 人数</span><input type="number" min="0" max="10" value={draft.mentionMin} onChange={(event) => updateDraft({ mentionMin: event.target.value })} /></label>
            <label><span>排除名单</span><textarea value={draft.blocklist} onChange={(event) => updateDraft({ blocklist: event.target.value })} placeholder="每行一个 UID 或昵称" /></label>
          </div>
          <div className="v3-toggle-list">
            <label><span><strong>候选去重</strong><small>同一用户只保留一次</small></span><input type="checkbox" checked={draft.uniqueByUser} onChange={(event) => updateDraft({ uniqueByUser: event.target.checked })} /></label>
            <label><span><strong>排除已中奖用户</strong><small>仅限当前浏览器的当前任务</small></span><input type="checkbox" checked={draft.excludePrevious} onChange={(event) => updateDraft({ excludePrevious: event.target.checked })} /></label>
          </div>
          <button
            type="button"
            className="flow-sheet-primary v3-primary-action"
            onClick={() => {
              if (controller.applyFilterDraft(draft)) close();
            }}
          >
            应用筛选
          </button>
        </>
      )}
    </SheetFrame>
  );
}

function DrawConfirmSheet({ controller: c, onClose, onConfirm, onPractice, onRefresh }) {
  const rawPreviousCount = c.previousDrawCount;
  const parsedPreviousCount = Number(rawPreviousCount);
  const countKnown = rawPreviousCount !== null
    && rawPreviousCount !== undefined
    && rawPreviousCount !== ''
    && Number.isInteger(parsedPreviousCount)
    && parsedPreviousCount >= 0;
  const previousCount = countKnown ? parsedPreviousCount : null;
  const nextCount = countKnown ? previousCount + 1 : null;
  const candidateSummary = c.candidateSummary || {
    total: Array.isArray(c.candidates) ? c.candidates.length : 0,
    eligible: Array.isArray(c.eligible) ? c.eligible.length : 0,
    excluded: Math.max(
      0,
      (Array.isArray(c.candidates) ? c.candidates.length : 0)
        - (Array.isArray(c.eligible) ? c.eligible.length : 0),
    ),
    reasonText: '',
  };

  return (
    <SheetFrame
      title="开奖前确认"
      subtitle="确认无误后再开始抽取"
      icon={I.shield}
      onClose={onClose}
      className="v3-draw-confirm-sheet"
    >
      {(close) => (
        <>
          <div className={`v3-confirm-hero ${previousCount > 0 ? 'is-repeat' : ''} ${previousCount === null ? 'is-unknown' : ''}`}>
            <span>{previousCount > 0 ? I.history : previousCount === null ? I.info : I.sparkles}</span>
            <div>
              <small>{previousCount === null ? '历史次数暂未核实' : previousCount > 0 ? `此前已完成 ${previousCount} 次` : '暂无历史开奖记录'}</small>
              <strong>{c.nextDrawText}</strong>
              <p>{previousCount === null ? '本次完成后会以服务器保存结果为准' : '只有成功保存的结果才会计入次数'}</p>
            </div>
          </div>

          {(c.candidateLoadError || c.candidateWarningText) && (
            <div className="v3-confirm-warning" role="note">
              {I.alert}
              <span>
                <strong>{c.candidateLoadError ? '候选载入未完成' : '请核对候选范围'}</strong>
                <small>{c.candidateLoadError || c.candidateWarningText}</small>
              </span>
            </div>
          )}

          <section className="v3-confirm-preview" aria-label="筛选结果预览">
            <header>
              <span>{I.listChecks}</span>
              <div>
                <strong>筛选结果预览</strong>
                <small>按当前名单和规则计算</small>
              </div>
              <em>{candidateSummary.excluded ? '请核对' : '范围清晰'}</em>
            </header>
            <div className="v3-confirm-preview-metrics">
              <div><strong>{candidateSummary.total.toLocaleString()}</strong><small>候选总数</small></div>
              <div><strong>{candidateSummary.eligible.toLocaleString()}</strong><small>可抽人数</small></div>
              <div><strong>{candidateSummary.excluded.toLocaleString()}</strong><small>已排除</small></div>
            </div>
            <p>
              <span>主要排除原因</span>
              <strong>{candidateSummary.reasonText || '暂无排除候选'}</strong>
            </p>
          </section>

          <dl className="v3-confirm-facts">
            <div><dt>可抽候选</dt><dd>{c.eligible.length.toLocaleString()} 人</dd></div>
            <div><dt>中奖名额</dt><dd>{c.totalSlots} 人</dd></div>
            <div className={c.candidateNeedsRefresh ? 'is-stale' : ''}>
              <dt>名单截止</dt>
              <dd>{c.candidateCutoffLabel}</dd>
            </div>
            <div><dt>筛选规则</dt><dd>{c.filterSummary}</dd></div>
          </dl>

          <div className="v3-confirm-prizes" aria-label="本轮奖项">
            {c.normalizedPrizes.map((prize, index) => (
              <div key={`${prize.name}-${index}`}>
                <span style={{ '--prize-color': prize.color }}>{index + 1}</span>
                <strong>{prize.name}</strong>
                <small>{prize.count} 名</small>
              </div>
            ))}
          </div>

          <p className="v3-repeat-note">
            {c.source === 'manual' ? I.info : previousCount > 0 ? I.info : previousCount === null ? I.alert : I.clock}
            {c.source === 'manual'
              ? '手动名单不会查询链接历史，请确认当前名单和奖项后再开始。'
              : !c.cooldownPersistent
              ? '本机存储不可用；当前页面内成功开奖后一分钟内不能重复开奖，刷新或关闭页面后限制可能失效。'
              : previousCount === null
              ? '历史次数暂未核实，本次完成后会显示服务器返回的实际次数。'
              : previousCount > 0
              ? `本次完成后显示为第 ${nextCount} 次；同一浏览器一分钟内不能重复开奖。`
              : '同一浏览器内，本链接成功开奖后一分钟内不能重复开奖。'}
          </p>

          <button type="button" className="flow-sheet-primary v3-primary-action v3-confirm-draw" onClick={() => onConfirm(close)}>
            {I.shuffle}
            <span>确认并开始抽奖</span>
          </button>
          <button type="button" className="v3-confirm-practice" onClick={() => onPractice(close)}>
            <span>{I.sparkles}</span>
            <span>
              <strong>本地演练</strong>
              <small>播放完整流程，不保存记录</small>
            </span>
            {I.chevron}
          </button>
          <div className="v3-confirm-secondary-actions">
            {c.source !== 'manual' && (
              <button type="button" onClick={() => close(onRefresh)}>
                {I.refresh}
                更新候选
              </button>
            )}
            <button type="button" onClick={() => close(() => c.setShowPrizeEditor(true))}>
              {I.gift}
              修改奖项
            </button>
          </div>
        </>
      )}
    </SheetFrame>
  );
}

function GuideSheet({ onClose }) {
  return (
    <SheetFrame title="使用教程" subtitle="从载入候选到保存结果" icon={I.book} onClose={onClose} className="flow-guide-sheet">
      {(close) => (
        <>
          <div className="flow-guide-list">
            {GUIDE_STEPS.map(([step, title, detail]) => (
              <div key={step} className="flow-guide-row">
                <span>{step}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{detail}</p>
                </div>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => close()} className="flow-sheet-primary v3-primary-action">知道了</button>
        </>
      )}
    </SheetFrame>
  );
}

function CandidateDetailSheet({ entry, apiBase, onClose, onCopy }) {
  const [copiedField, setCopiedField] = useState('');
  const copiedTimerRef = useRef(null);

  useEffect(() => {
    setCopiedField('');
    window.clearTimeout(copiedTimerRef.current);
    return () => window.clearTimeout(copiedTimerRef.current);
  }, [entry]);

  if (!entry?.candidate) return null;
  const { candidate } = entry;
  const name = candidate.screenName || candidate.uid || '候选用户';
  const sourceText = friendlyProviderText(candidate.source) || '候选名单';
  const createdAt = formattedCandidateTime(candidate.createdAt);

  async function copyField(value, field, successMessage) {
    const copied = await onCopy(value, successMessage);
    if (!copied) return;
    setCopiedField(field);
    window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopiedField(''), 1600);
  }

  return (
    <SheetFrame
      title="候选详情"
      subtitle={entry.eligible ? '符合当前筛选规则' : entry.reasonLabel}
      icon={I.users}
      onClose={onClose}
      className="candidate-detail-sheet"
    >
      {(close) => (
        <>
          <div className="candidate-detail-identity">
            <CandidateAvatar candidate={candidate} className="candidate-detail-avatar" apiBase={apiBase} priority />
            <div>
              <span className={entry.eligible ? 'is-eligible' : 'is-excluded'}>
                {entry.eligible ? '可参与本轮抽奖' : entry.reasonLabel}
              </span>
              <strong>{name}</strong>
              <small>{candidate.uid ? `UID ${candidate.uid}` : sourceText}</small>
            </div>
          </div>

          <dl className="candidate-detail-facts">
            <div><dt>候选状态</dt><dd>{entry.eligible ? '可抽' : '已排除'}</dd></div>
            {!entry.eligible && <div><dt>排除原因</dt><dd>{entry.reasonDetail}</dd></div>}
            <div><dt>数据来源</dt><dd>{sourceText}</dd></div>
            {createdAt && <div><dt>转发时间</dt><dd>{createdAt}</dd></div>}
          </dl>

          {candidate.text && (
            <section className="candidate-detail-text">
              <h3>转发内容</h3>
              <p>{candidate.text}</p>
            </section>
          )}

          <div className="candidate-detail-actions">
            <button type="button" aria-label="复制昵称" onClick={() => copyField(name, 'name', '昵称已复制。')}>
              {I.copy} {copiedField === 'name' ? '已复制' : '复制昵称'}
            </button>
            {candidate.uid && (
              <button type="button" aria-label="复制 UID" onClick={() => copyField(String(candidate.uid), 'uid', 'UID 已复制。')}>
                {I.copy} {copiedField === 'uid' ? '已复制' : '复制 UID'}
              </button>
            )}
          </div>
          <button type="button" onClick={() => close()} className="flow-sheet-primary v3-primary-action">完成</button>
        </>
      )}
    </SheetFrame>
  );
}

function FeedbackSheet({ initialCategory = FEEDBACK_CATEGORIES[0].value, onClose, onSubmit }) {
  const [category, setCategory] = useState(initialCategory);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState('');
  const textareaRef = useRef(null);
  const submittingRef = useRef(false);

  const focusComposer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  async function submit(event) {
    event.preventDefault();
    if (submittingRef.current) return;
    setError('');
    try {
      const payload = normalizeFeedbackSubmission({ category, content });
      submittingRef.current = true;
      setSubmitting(true);
      const receipt = await onSubmit(payload);
      setSent(receipt || {});
    } catch (submitError) {
      setError(submitError.message || '反馈暂时未能送达，请稍后再试');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function moveCategoryFocus(event, index) {
    const directions = {
      ArrowDown: 1,
      ArrowRight: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
    };
    let nextIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = FEEDBACK_CATEGORIES.length - 1;
    else if (directions[event.key]) {
      nextIndex = (index + directions[event.key] + FEEDBACK_CATEGORIES.length) % FEEDBACK_CATEGORIES.length;
    } else return;
    event.preventDefault();
    setCategory(FEEDBACK_CATEGORIES[nextIndex].value);
    event.currentTarget.parentElement?.children[nextIndex]?.focus();
  }

  return (
    <SheetFrame
      title="意见反馈"
      subtitle="你的建议会由站长直接查看"
      icon={I.feedback}
      onClose={onClose}
      className="flow-feedback-sheet"
      initialFocusRef={focusComposer ? textareaRef : null}
    >
      {(close) => sent ? (
        <div className="feedback-success" role="status" aria-live="polite" aria-atomic="true">
          <span>{I.check}</span>
          <h3>谢谢你的反馈</h3>
          <p>内容已经送达，站长会在后台查看。</p>
          {sent.id && <code>反馈编号 {sent.id}</code>}
          <button type="button" className="flow-sheet-primary v3-primary-action" onClick={() => close()}>完成</button>
        </div>
      ) : (
        <form className="feedback-form" onSubmit={submit}>
          <fieldset className="feedback-category">
            <legend id="feedback-category-label">反馈类型</legend>
            <div role="radiogroup" aria-labelledby="feedback-category-label">
              {FEEDBACK_CATEGORIES.map((item, index) => (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  className={category === item.value ? 'is-active' : ''}
                  aria-checked={category === item.value}
                  tabIndex={category === item.value ? 0 : -1}
                  onClick={() => setCategory(item.value)}
                  onKeyDown={(event) => moveCategoryFocus(event, index)}
                >
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </button>
              ))}
            </div>
          </fieldset>

          <label className="feedback-editor">
            <span>反馈内容</span>
            <textarea
              ref={textareaRef}
              value={content}
              maxLength={FEEDBACK_MAX_LENGTH}
              placeholder={category === 'privacy' ? '请填写过程哈希或反馈编号，以及需要处理的数据…' : '请描述你的建议或遇到的问题…'}
              onChange={(event) => {
                setContent(event.target.value);
                if (error) setError('');
              }}
              aria-describedby={`feedback-hint${error ? ' feedback-error' : ''}`}
            />
            <span className="feedback-count">{content.length} / {FEEDBACK_MAX_LENGTH}</span>
          </label>

          <p className="feedback-privacy" id="feedback-hint">
            {I.shield} {category === 'privacy' ? '请勿填写 Cookie、密码、身份证号等敏感信息' : '请勿填写 Cookie、密码等敏感信息'}
          </p>
          {error && <p className="feedback-error" id="feedback-error" role="alert" aria-live="assertive">{error}</p>}
          <button type="submit" className="flow-sheet-primary v3-primary-action feedback-submit" disabled={submitting || content.trim().length < 2}>
            {submitting ? I.refresh : I.send}
            <span>{submitting ? '正在提交' : '提交反馈'}</span>
          </button>
        </form>
      )}
    </SheetFrame>
  );
}

function LegalSheet({ document, onClose, onOpenPrivacyRequest, onOpenUpdates }) {
  if (!document) return null;
  return (
    <SheetFrame key={document.key || document.title} title={document.title} subtitle={document.subtitle} icon={document.key === 'updates' ? I.history : I.file} onClose={onClose} className="flow-legal-sheet">
      {(close) => (
        <>
          <p className="flow-legal-date">更新日期：2026 年 8 月 25 日</p>
          {document.updates ? (
            <div className="flow-update-list">
              {document.updates.map((entry) => (
                <article className="flow-update-entry" key={entry.version}>
                  <header>
                    <div><strong>版本 {entry.version}</strong><small>{entry.date}</small></div>
                    <span>{entry.label}</span>
                  </header>
                  <h3>{entry.title}</h3>
                  {entry.summary && <p>{entry.summary}</p>}
                  {entry.items.length > 0 && <ul>{entry.items.map((item) => <li key={item}>{item}</li>)}</ul>}
                </article>
              ))}
            </div>
          ) : (
            <>
              <div className="flow-legal-sections">
                {document.sections.map(([title, detail]) => (
                  <section key={title}>
                    <h3>{title}</h3>
                    <p>{detail}</p>
                  </section>
                ))}
              </div>
              {document.key === 'about' && (
                <button type="button" className="flow-legal-update-link list-row" onClick={() => close(onOpenUpdates)}>
                  <span className="row-icon mint">{I.history}</span>
                  <span className="row-copy"><strong>更新日志</strong><small>查看 {APP_VERSION} 与历史正式版本</small></span>
                  {I.chevron}
                </button>
              )}
              {document.noticeHref && (
                <a className="flow-legal-update-link list-row" href={document.noticeHref} target="_blank" rel="noreferrer">
                  <span className="row-icon mint">{I.file}</span>
                  <span className="row-copy"><strong>完整许可清单</strong><small>查看第三方版权声明与许可文本</small></span>
                  {I.chevron}
                </a>
              )}
              {document.key === 'privacy' && (
                <button type="button" className="flow-legal-update-link list-row" onClick={() => close(onOpenPrivacyRequest)}>
                  <span className="row-icon lilac">{I.feedback}</span>
                  <span className="row-copy"><strong>提交隐私与数据请求</strong><small>查询或申请删除服务器记录</small></span>
                  {I.chevron}
                </button>
              )}
            </>
          )}
          <button type="button" onClick={() => close()} className="flow-sheet-primary v3-primary-action">完成</button>
        </>
      )}
    </SheetFrame>
  );
}

function SectionTitle({ title, action, onAction }) {
  return (
    <header className="section-header">
      <h2>{title}</h2>
      {action && <button type="button" onClick={onAction}>{action}</button>}
    </header>
  );
}

function AppListRow({ id, icon, tone = 'blue', title, detail, value, onClick }) {
  return (
    <button id={id} className="list-row" type="button" onClick={onClick}>
      <span className={`row-icon ${tone}`}>{icon}</span>
      <span className="row-copy">
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {value && <span className="row-value">{value}</span>}
      {I.chevron}
    </button>
  );
}

function AppleNavigationV3({ controller: c }) {
  const drawState = c.isDrawing ? 'running' : c.hasResults ? 'finished' : 'ready';
  const [candidateLimit, setCandidateLimit] = useState(CANDIDATE_BATCH_SIZE);
  const [selectedCandidateEntry, setSelectedCandidateEntry] = useState(null);
  const [settingsDisclosures, setSettingsDisclosures] = useState({ cookie: false, backend: false });
  const drawDeckRef = useRef(null);
  const drawSceneRef = useRef(null);
  const deckAnimationsRef = useRef([]);
  const previousDrawStateRef = useRef(drawState);
  const deferredCandidateQuery = useDeferredValue(c.candidateQuery);

  useEffect(() => {
    const reducedMotion = shouldReduceMotion(c.motionPreference);
    const deck = drawDeckRef.current;
    const previousState = previousDrawStateRef.current;
    const currentTransforms = drawState === 'finished' && previousState === 'running' && deck
      ? [...deck.querySelectorAll('[data-deck-card]')].map((card) => getComputedStyle(card).transform)
      : [];
    cancelDrawDeckMotion(deckAnimationsRef.current);
    deckAnimationsRef.current = [];

    if (drawState === 'running') {
      deckAnimationsRef.current = startDrawDeckMotion(deck, { reducedMotion });
    } else if (drawState === 'finished' && previousState === 'running') {
      deckAnimationsRef.current = settleDrawDeckMotion(deck, {
        reducedMotion,
        readTransform: (_, index) => currentTransforms[index] || 'none',
      });
    }
    previousDrawStateRef.current = drawState;
  }, [drawState, c.motionPreference]);

  useEffect(() => () => {
    cancelDrawDeckMotion(deckAnimationsRef.current);
  }, []);

  const tabIndex = { home: 0, candidates: 1, history: 2, more: 3 }[c.activeTab] ?? 0;
  const sourceSegmentIndex = Math.max(0, SOURCE_OPTIONS.findIndex((option) => option.value === c.source));
  const candidateSegmentIndex = { eligible: 0, all: 1, excluded: 2 }[c.candidateSegment] ?? 0;
  const motionSegmentIndex = Math.max(0, MOTION_OPTIONS.findIndex((option) => option.value === c.motionPreference));
  const candidateGroups = useMemo(() => {
    const evaluationByCandidate = new Map(
      c.candidateEvaluations.map((entry) => [entry.candidate, entry]),
    );
    const excludedCandidates = c.candidateEvaluations
      .filter((entry) => !entry.eligible)
      .map((entry) => entry.candidate);
    const segmentCandidates = c.candidateSegment === 'all'
      ? c.candidates
      : c.candidateSegment === 'excluded'
        ? excludedCandidates
        : c.eligible;
    return { evaluationByCandidate, excludedCandidates, segmentCandidates };
  }, [c.candidateSegment, c.candidates, c.candidateEvaluations, c.eligible]);
  const candidateView = useMemo(() => {
    const query = deferredCandidateQuery.trim().toLowerCase();
    const { segmentCandidates } = candidateGroups;
    const matchingCandidates = segmentCandidates.filter((candidate) => !query || [
      candidate.screenName,
      candidate.uid,
      candidate.text,
    ].some((value) => String(value || '').toLowerCase().includes(query)));
    return { ...candidateGroups, matchingCandidates, query };
  }, [candidateGroups, deferredCandidateQuery]);
  const { evaluationByCandidate, excludedCandidates, matchingCandidates, query } = candidateView;
  const browsableCandidateCount = Math.min(matchingCandidates.length, CANDIDATE_RENDER_LIMIT);
  const visibleCandidates = matchingCandidates.slice(0, Math.min(candidateLimit, browsableCandidateCount));
  const remainingCandidates = Math.max(0, browsableCandidateCount - visibleCandidates.length);
  const searchOnlyCandidates = Math.max(0, matchingCandidates.length - browsableCandidateCount);

  useEffect(() => {
    setCandidateLimit(CANDIDATE_BATCH_SIZE);
  }, [c.candidateSegment, c.candidates, deferredCandidateQuery]);
  const historySearch = String(c.historyQuery || '').trim().toLowerCase();
  const filteredHistory = useMemo(() => {
    if (!historySearch) return c.drawHistory;
    return c.drawHistory.filter((item) => {
      const searchable = [
        item.statusUrl,
        item.statusId,
        item.drawNumber,
        ...(item.results || []).flatMap((group) => [
          group.prize?.name,
          ...(group.winners || []).flatMap((winner) => [winner.screenName, winner.uid]),
        ]),
      ].map((value) => String(value || '').toLowerCase());
      return searchable.some((value) => value.includes(historySearch));
    });
  }, [c.drawHistory, historySearch]);
  const visibleHistory = c.historyExpanded ? filteredHistory : filteredHistory.slice(0, 3);
  const totalHistoricWinners = c.drawHistory.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const latestHistory = c.drawHistory.slice(0, 2);
  const sourceDetail = {
    mobile: '当前可见的微博转发',
    manual: '粘贴、填写或文件导入',
    official: '微博官方接口',
  }[c.source];
  const stageCandidate = c.isDrawing
    ? c.rollingCandidate || c.eligible[0] || c.candidates[0]
    : c.eligible[0] || c.candidates[0];
  const primaryResult = c.results.find((item) => item.winners?.length);
  const primaryWinner = primaryResult?.winners?.[0];
  const stackOpen = Boolean(
    c.showGuide
    || c.showFeedback
    || c.legalDocument
    || c.confirmAction
    || c.showDrawConfirm
    || c.showSourceEditor
    || c.showPrizeEditor
    || c.showFilters
    || c.showSettings
    || c.selectedReceipt
    || selectedCandidateEntry,
  );
  const contentInert = stackOpen || c.notice?.tone === 'error';
  const layerSignature = [
    c.notice?.tone === 'error' ? `notice:${c.notice.id}` : '',
    c.showGuide ? 'guide' : '',
    c.showFeedback ? 'feedback' : '',
    c.legalDocument ? 'legal' : '',
    c.confirmAction ? 'confirm' : '',
    c.showDrawConfirm ? 'draw-confirm' : '',
    c.showSourceEditor ? 'source' : '',
    c.showPrizeEditor ? 'prize' : '',
    c.showFilters ? 'filters' : '',
    c.showSettings ? 'settings' : '',
    c.selectedReceipt ? 'receipt' : '',
    selectedCandidateEntry ? 'candidate' : '',
  ].filter(Boolean).join('|');
  useLayoutEffect(() => {
    const pageRegions = [...document.querySelectorAll('.root-navbar, .root-pages, .root-tabbar')];
    const layers = [...document.querySelectorAll('.v3-alert-backdrop, .flow-sheet-backdrop, .receipt-backdrop')];
    const topLayer = layers.reduce((currentTop, layer) => {
      if (!currentTop) return layer;
      const currentZIndex = Number.parseInt(window.getComputedStyle(currentTop).zIndex, 10) || 0;
      const layerZIndex = Number.parseInt(window.getComputedStyle(layer).zIndex, 10) || 0;
      return layerZIndex >= currentZIndex ? layer : currentTop;
    }, null);
    pageRegions.forEach((region) => {
      if (contentInert) region.setAttribute('inert', '');
      else region.removeAttribute('inert');
    });
    layers.forEach((layer) => {
      if (layer !== topLayer) layer.setAttribute('inert', '');
      else layer.removeAttribute('inert');
    });
    return () => {
      pageRegions.forEach((region) => region.removeAttribute('inert'));
      layers.forEach((layer) => layer.removeAttribute('inert'));
    };
  }, [contentInert, layerSignature]);
  const intakeState = c.isLoading
    ? 'loading'
    : c.candidateLoadError
      ? 'error'
    : c.hasCandidates
      ? drawState
      : c.candidateLoadCompleted
        ? 'checked-empty'
        : c.statusUrl.trim() ? 'link-ready' : 'empty';
  const intakePercent = Math.max(0, Math.min(100, Math.round(c.progress?.percent || 0)));
  const visibleWinners = c.results
    .flatMap((item) => item.winners.map((winner) => ({
      candidate: winner,
      prizeName: item.prize.name,
    })))
    .slice(0, 4);
  const resultReceipt = c.currentReceipt || c.drawHistory[0] || null;
  const stageName = stageCandidate?.screenName || stageCandidate?.uid || '候选用户';
  const compactUid = (candidate) => {
    const uid = String(candidate?.uid || '');
    if (!uid) return friendlyProviderText(candidate?.source) || '微博候选';
    return uid.length > 8 ? `UID ${uid.slice(0, 4)}••••${uid.slice(-2)}` : `UID ${uid}`;
  };
  const drawAction = c.candidateLoadError || (c.hasCandidates && !c.candidateSourceReady)
    ? {
      icon: I.link,
      title: c.candidateLoadError ? '重新载入候选' : '载入当前来源',
      detail: c.candidateLoadError
        ? c.hasCandidates ? '上次名单仍在页面中，刷新成功后才能开奖' : '请检查链接或登录态后重试'
        : '来源或链接已更改，载入后再设置奖项',
    }
    : !c.eligible.length
    ? {
      icon: I.listChecks,
      title: '调整筛选',
      detail: '当前没有符合条件的候选',
    }
    : c.drawSetupConfirmed
      ? {
        icon: I.shuffle,
        title: '核对并开奖',
        detail: `${c.nextDrawText} · 将抽取 ${c.totalSlots} 人`,
      }
      : {
        icon: I.gift,
        title: '设置奖项并确认',
        detail: `${c.normalizedPrizes.length} 个奖项 · ${c.totalSlots} 个名额`,
      };

  useEffect(() => {
    if (!c.showSettings) return undefined;
    if (c.settingsTarget === 'cookie' || c.settingsTarget === 'backend') {
      setSettingsDisclosures((current) => ({ ...current, [c.settingsTarget]: true }));
    }
    if (!c.settingsTarget || c.settingsTarget === 'overview') return undefined;
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-settings-section="${c.settingsTarget}"]`)?.scrollIntoView({
        block: 'start',
        behavior: shouldReduceMotion(c.motionPreference) ? 'auto' : 'smooth',
      });
    }, 360);
    return () => window.clearTimeout(timer);
  }, [c.motionPreference, c.settingsTarget, c.showSettings]);

  const switchTab = (tab, { focus = false } = {}) => {
    c.setActiveTab(tab);
    window.requestAnimationFrame(() => {
      if (!c.isBusy) {
        document.querySelector(`[data-root-view="${tab}"] .root-scroll`)?.scrollTo({
          top: 0,
          behavior: 'auto',
        });
      }
      if (focus) {
        document.querySelector(`.root-tabbar [data-tab-target="${tab}"]`)?.focus({
          preventScroll: true,
        });
      }
    });
  };

  const requestDraw = () => {
    c.requestDraw();
  };

  const confirmDraw = (close) => {
    drawSceneRef.current?.scrollIntoView({
      behavior: 'auto',
      block: 'nearest',
    });
    c.confirmAndDraw({ close });
  };
  const practiceDraw = (close) => {
    drawSceneRef.current?.scrollIntoView({
      behavior: 'auto',
      block: 'nearest',
    });
    c.confirmAndDraw({ practice: true, close });
  };

  return (
    <div
      className={`app-shell v3-app-shell ${stackOpen ? 'stack-open' : ''}`}
      data-draw-state={drawState}
      data-intake-state={intakeState}
      data-motion={c.motionPreference}
      data-setup={c.drawSetupConfirmed ? 'confirmed' : 'unconfirmed'}
      data-root-tab={c.activeTab === 'home' ? 'draw' : c.activeTab}
    >
      <header className="root-navbar glass" inert={contentInert ? '' : undefined}>
        <button className="brand-button" type="button" onClick={() => switchTab('more')}>
          <img src={publicAsset('avatar-96.webp')} alt="" width="48" height="48" />
          <span>
            <strong>微博转发抽奖</strong>
            <small>by.sameko</small>
          </span>
        </button>
        <div className="navbar-actions">
          <button className={c.showGuide ? 'is-presenting' : ''} type="button" onClick={() => c.setShowGuide(true)} aria-label="使用教程" aria-expanded={c.showGuide}>
            {I.book}
          </button>
          <button className={c.showSettings ? 'is-presenting' : ''} type="button" onClick={() => c.openSettings()} aria-label="设置" aria-expanded={c.showSettings}>
            {I.settings}
          </button>
        </div>
      </header>

      <NoticeToast notice={c.notice} onClose={c.dismissNotice} />
      <div
        className="sr-only"
        role="status"
        aria-live={c.notice?.tone === 'error' ? 'off' : c.statusTone === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
        data-app-status={c.statusTone}
      >
        {c.status}
      </div>
      {c.confirmAction && (
        <ConfirmActionDialog
          action={c.confirmAction}
          motionPreference={c.motionPreference}
          onClose={() => c.setConfirmAction(null)}
          onConfirm={() => c.applySettingsAction(c.confirmAction.kind)}
        />
      )}

      <main className="root-pages" inert={contentInert ? '' : undefined}>
        <section className={`root-view ${c.activeTab === 'home' ? 'is-active' : ''}`} data-root-view="home" hidden={c.activeTab !== 'home'}>
          <div className="root-scroll">
            <h1 className="sr-only">微博转发抽奖</h1>
            <section className={`draw-studio ${!c.hasCandidates ? 'is-empty' : ''}`} aria-label="抽奖控制台">
              <header className="studio-header">
                <div>
                  <span className={`title-status ${c.isLoading || c.isDrawing ? 'is-busy' : ''}`}>
                    <i />
                     {c.isLoading
                       ? '正在载入候选'
                       : c.candidateLoadError
                       ? c.hasCandidates ? '上次名单待复核' : '候选载入失败'
                       : c.isDrawing
                      ? c.phase === '正在同步开奖记录' ? '正在同步结果' : '正在抽取'
                        : c.hasResults
                          ? '本轮开奖已完成'
                          : c.hasCandidates
                            ? c.candidateWarningText
                              ? '请核对候选范围'
                              : !c.candidateSourceReady
                              ? '请载入当前来源'
                              : c.drawSetupConfirmed ? '已准备开奖' : '请确认奖项'
                            : c.candidateLoadCompleted ? '未找到可见候选' : '等待载入候选'}
                  </span>
                  <strong>
                     {c.hasCandidates
                       ? c.candidateLoadError
                         ? '刷新未完成，当前名单不能直接开奖'
                         : `${c.eligible.length.toLocaleString()} 名候选 · ${c.normalizedPrizes.length} 个奖项 · ${c.totalSlots} 个名额`
                       : c.candidateLoadError ? '请重新载入候选名单' : c.candidateLoadCompleted ? '可以更新名单或改用手动导入' : '粘贴微博链接即可载入'}
                  </strong>
                </div>
                <button className={c.showFilters ? 'is-presenting' : ''} type="button" onClick={() => c.setShowFilters(true)} aria-expanded={c.showFilters}>
                  {I.listChecks}
                  筛选
                </button>
              </header>

              {!c.hasCandidates ? (
                <>
                   <div className={`draw-scene v3-intake-scene ${c.statusUrl.trim() ? 'has-link' : ''} ${c.candidateLoadError ? 'has-error' : ''}`}>
                    <div className="scene-geometry" aria-hidden="true"><i /><i /></div>
                    <div className="scene-glint" aria-hidden="true" />
                    <div className="v3-intake-deck-frame">
                      <div className="candidate-deck v3-intake-deck">
                        <article className="candidate-pass pass-under pass-coral" aria-hidden="true"><span /><i /></article>
                        <article className="candidate-pass pass-under pass-blue" aria-hidden="true"><span /><i /></article>
                        <article className="candidate-pass pass-main">
                          <header>
                            <span>候选</span>
                            {I.shield}
                          </header>
                          <div className="pass-identity">
                            <span className="pass-avatar v3-intake-symbol">
                              {I.link}
                              <i>{I.sparkles}</i>
                            </span>
                           <span aria-hidden="true">
                               <small>{c.isLoading ? '正在载入候选' : c.candidateLoadError ? '载入未完成' : c.candidateLoadCompleted ? '候选检查已完成' : '微博转发名单'}</small>
                               <strong>{c.isLoading ? `${intakePercent}%` : c.candidateLoadError ? '请重新载入' : c.candidateLoadCompleted ? '未找到候选' : c.statusUrl.trim() ? '链接已识别' : '等待链接'}</strong>
                               <em>{c.isLoading ? c.progress?.message || '正在读取当前可见转发' : c.candidateLoadError || (c.candidateLoadCompleted ? '当前登录态没有返回可见转发' : c.statusUrl.trim() ? '可以载入候选名单' : '载入后会显示符合条件的候选')}</em>
                            </span>
                          </div>
                          <footer>
                            <span><small>来源</small><strong>微博转发</strong></span>
                            <span><small>载入</small><strong>{c.isLoading ? '进行中' : '链接识别'}</strong></span>
                            <span><small>状态</small><strong>{c.isLoading ? '请稍候' : c.candidateLoadError ? '需重试' : c.candidateLoadCompleted ? '无可见记录' : c.statusUrl.trim() ? '可载入' : '待载入'}</strong></span>
                          </footer>
                        </article>
                      </div>
                    </div>
                  </div>
                  <div className="v3-intake-controls">
                    <div className="v3-link-field">
                      <label className="sr-only" htmlFor="weibo-status-url">微博链接、mid 或 bid</label>
                      <input
                        id="weibo-status-url"
                        ref={c.homeStatusInputRef}
                        value={c.statusUrl}
                        onChange={(event) => c.updateStatusInput(event.target.value)}
                        onPaste={c.handleStatusPaste}
                        name="weiboStatusUrl"
                        autoComplete="off"
                        inputMode="url"
                        placeholder="粘贴微博正文链接、mid 或 bid…"
                      />
                      {c.statusUrl.trim() && (
                        <button
                          type="button"
                          aria-label="清空微博链接"
                          onClick={() => {
                            c.updateStatusInput('');
                            c.homeStatusInputRef.current?.focus();
                          }}
                        >
                          {I.close}
                        </button>
                      )}
                    </div>
                    <button
                      className="primary-button v3-load-button v3-primary-action"
                      type="button"
                      onClick={c.pasteAndLoadCandidates}
                      disabled={c.isLoading}
                    >
                      <span className="draw-button-icon">{c.isLoading ? I.refresh : I.link}</span>
                      <span>
                         <strong>{c.isLoading ? '正在载入候选' : c.candidateLoadError && c.statusUrl.trim() ? '重新载入候选' : c.statusUrl.trim() ? '载入候选' : '粘贴链接并载入'}</strong>
                        <small>优先使用服务器登录态</small>
                      </span>
                      {I.chevron}
                    </button>
                    <button className="v3-text-action" type="button" onClick={() => c.selectCandidateSource('manual')} disabled={c.isLoading}>
                      或手动导入候选名单
                      {I.chevron}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="draw-scene" ref={drawSceneRef}>
                    <div className="scene-geometry" aria-hidden="true"><i /><i /></div>
                    <div className="scene-glint" aria-hidden="true" />
                    <div className="candidate-deck" ref={drawDeckRef}>
                      <article className="candidate-pass pass-under pass-coral" data-deck-card aria-hidden="true"><span /><i /></article>
                      <article className="candidate-pass pass-under pass-blue" data-deck-card aria-hidden="true"><span /><i /></article>
                      <article className="candidate-pass pass-main lens-center" data-deck-card>
                        <header>
                          <span>{c.isDrawing ? c.phase === '正在同步开奖记录' ? '正在同步结果' : '正在抽取候选' : '候选'}</span>
                          {I.shield}
                        </header>
                        <div className="pass-identity">
                           <CandidateAvatar candidate={stageCandidate} className="pass-avatar" apiBase={c.apiBase} priority={c.isDrawing} />
                          <span key={c.isDrawing ? candidateIdentity(stageCandidate) || stageName : `${drawState}-${c.eligible.length}`}>
                            <small>{c.isDrawing ? c.phase || '正在抽取' : '候选已载入'}</small>
                            <strong>{c.isDrawing ? stageName : c.eligible.length.toLocaleString()}</strong>
                            <em>{c.isDrawing ? compactUid(stageCandidate) : '名候选'}</em>
                          </span>
                        </div>
                        <footer>
                          <span><small>奖项</small><strong>{c.normalizedPrizes.length} 个</strong></span>
                          <span><small>名额</small><strong>{c.totalSlots} 名</strong></span>
                          <span><small>状态</small><strong>{c.isDrawing ? '抽取中' : !c.candidateSourceReady ? '待载入' : c.eligible.length ? c.drawSetupConfirmed ? '可开奖' : '待确认' : '需调整'}</strong></span>
                        </footer>
                      </article>
                      <article className="candidate-pass winner-core" aria-hidden={!c.hasResults}>
                        <header>
                          <span>中奖结果</span>
                          {I.badgeCheck}
                        </header>
                        <div className="pass-identity">
                          <CandidateAvatar candidate={primaryWinner} className="pass-avatar" apiBase={c.apiBase} priority />
                          <span>
                            <small>{primaryResult?.prize?.name || '幸运奖'}</small>
                            <strong>{primaryWinner?.screenName || primaryWinner?.uid || '幸运用户'}</strong>
                            <em>{compactUid(primaryWinner)}</em>
                          </span>
                        </div>
                        <footer>
                          <span><small>奖项</small><strong>{primaryResult?.prize?.name || '幸运奖'}</strong></span>
                          <span><small>结果</small><strong>已记录</strong></span>
                        </footer>
                      </article>
                    </div>
                    <div className="scene-caption" aria-hidden="true">
                      <span><i /><b>{c.isDrawing ? '抽取中' : c.hasResults ? '已完成' : !c.candidateSourceReady ? '待载入' : c.drawSetupConfirmed ? '待开始' : '待确认'}</b></span>
                      <small>微博抽奖</small>
                    </div>
                    <div className="result-rail" aria-label="中奖结果" aria-hidden={!c.hasResults}>
                      {c.hasResults && (
                        <>
                          <header>
                            <div>
                              <span>开奖结果</span>
                              <strong>{c.resultTotal} 名幸运用户</strong>
                            </div>
                            <button type="button" onClick={() => c.setSelectedReceipt(resultReceipt)}>查看结果</button>
                          </header>
                          <div className="winner-list">
                            {visibleWinners.map(({ candidate, prizeName }, index) => (
                              <button
                                type="button"
                                key={candidate.id || candidate.uid || candidate.screenName || index}
                                onClick={() => c.showStatus(compactUid(candidate), 'success', {
                                  popup: true,
                                  title: candidate.screenName || candidate.uid || '获奖用户',
                                })}
                              >
                                <CandidateAvatar candidate={candidate} className={`avatar ${['pink', 'blue', 'lilac', 'mint'][index % 4]}`} apiBase={c.apiBase} decorative />
                                <strong>{candidate.screenName || candidate.uid || `获奖用户 ${index + 1}`}</strong>
                                <small>{prizeName}</small>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="draw-specs" aria-label="开奖准备情况">
                    <button
                      type="button"
                      className={c.showSourceEditor ? 'is-presenting' : ''}
                      data-state={c.candidateSourceReady ? 'complete' : 'pending'}
                      aria-expanded={c.showSourceEditor}
                      aria-label={`候选：${c.eligible.length.toLocaleString()} 人，${c.candidateSourceReady ? '已载入' : '待载入'}`}
                      onClick={() => c.setShowSourceEditor(true)}
                    >
                      <span className="spec-icon blue">{I.users}</span>
                      <span><small>候选</small><strong>{c.eligible.length.toLocaleString()}</strong></span>
                    </button>
                    <button
                      type="button"
                      className={`${c.drawSetupConfirmed ? 'is-confirmed' : ''} ${c.showPrizeEditor ? 'is-presenting' : ''}`.trim()}
                      data-state={c.drawSetupConfirmed ? 'complete' : 'pending'}
                      aria-expanded={c.showPrizeEditor}
                      aria-label={`奖项：${c.normalizedPrizes.length} 个，${c.drawSetupConfirmed ? '已确认' : '待确认'}`}
                      onClick={() => c.setShowPrizeEditor(true)}
                    >
                      <span className="spec-icon coral">{I.gift}</span>
                       <span><small>奖项</small><strong>{c.normalizedPrizes.length} 个</strong></span>
                    </button>
                    <button type="button" className={c.showFilters ? 'is-presenting' : ''} data-state="complete" aria-expanded={c.showFilters} aria-label={`筛选规则：${c.filterEnabledText}`} onClick={() => c.setShowFilters(true)}>
                      <span className="spec-icon mint">{I.badgeCheck}</span>
                      <span><small>规则</small><strong>{c.filterEnabledText}</strong></span>
                    </button>
                  </div>
                  <div className="v3-draw-count">
                    {I.shield}
                    <span>
                      <strong>{c.drawCountText}</strong>
                      <small>仅统计成功保存的结果</small>
                    </span>
                  </div>
                  <div className="draw-control">
                    <div className="draw-control-state draw-ready">
                      <button
                        className="primary-button v3-primary-action"
                        type="button"
                        onClick={requestDraw}
                        disabled={c.isDrawing || c.isLoading}
                      >
                        <span className="draw-button-icon">{drawAction.icon}</span>
                        <span>
                          <strong>{drawAction.title}</strong>
                          <small>{drawAction.detail}</small>
                        </span>
                        {I.chevron}
                      </button>
                    </div>
                    <div className="draw-control-state draw-running">
                      <span className="progress-indicator" />
                      <span>
                         <small>{c.phase || '正在抽取候选'}</small>
                        <strong>{stageName}</strong>
                      </span>
                      <button type="button" onClick={c.cancelDraw} aria-label="停止本次开奖">
                        {I.close} 停止
                      </button>
                    </div>
                    <div className="draw-control-state draw-finished">
                      <div>
                        <span className="complete-icon">{I.check}</span>
                        <span><small>开奖完成</small><strong>{c.drawCountText}</strong></span>
                      </div>
                      <div className="result-buttons">
                        <button type="button" aria-label="设置并再次抽奖" title="设置并再次抽奖" onClick={requestDraw}>{I.shuffle}</button>
                        <button type="button" aria-label="查看开奖结果" title="查看开奖结果" onClick={() => c.setSelectedReceipt(resultReceipt)}>{I.clock}</button>
                      </div>
                    </div>
                  </div>
                </>
               )}

               {c.candidateLoadError && c.hasCandidates && (
                 <div className="v3-candidate-warning v3-candidate-warning-error" role="note">
                   {I.alert}
                   <div><strong>候选名单未更新</strong><small>{c.candidateLoadError} 上次名单仍保留，仅供查看；重新载入后才能开奖。</small></div>
                 </div>
               )}

               <CandidateLoadProgress progress={c.progress} isLoading={c.isLoading} onCancel={c.cancelCandidateLoad} />
            </section>

            <section className="content-section">
              <SectionTitle title="抽奖设置" />
              <div className="grouped-list">
                <AppListRow
                  id="candidate-source-row"
                  icon={I.link}
                  title="候选来源"
                  detail={sourceDetail}
                  value={c.hasCandidates ? `${c.loadedCandidateCount.toLocaleString()} 人` : '待载入'}
                  onClick={() => c.setShowSourceEditor(true)}
                />
                <AppListRow
                  icon={I.gift}
                  tone="coral"
                  title="奖项设置"
                  detail={`${c.normalizedPrizes.length} 个奖项，共 ${c.totalSlots} 个名额`}
                  onClick={() => c.setShowPrizeEditor(true)}
                />
                <AppListRow
                  icon={I.listChecks}
                  tone="mint"
                  title="筛选规则"
                  detail={c.filterSummary}
                  onClick={() => c.setShowFilters(true)}
                />
              </div>
            </section>

            <section className="content-section">
              <SectionTitle
                title="开奖记录"
                action={c.drawHistory.length ? '查看全部' : ''}
                onAction={() => switchTab('history', { focus: true })}
              />
              {latestHistory.length ? (
                <div className="compact-records">
                  {latestHistory.map((item, index) => (
                    <button
                      type="button"
                      key={`${item.time}-${index}`}
                      onClick={() => c.setSelectedReceipt(item)}
                    >
                      <span className={`record-mark ${index ? 'blue' : 'pink'}`}>{index ? I.sparkles : I.gift}</span>
                      <span><strong>{item.results?.[0]?.prize?.name || '微博转发抽奖'}</strong><small>{item.total} 名获奖用户</small></span>
                      <time>{historyDateParts(item.time).compact}</time>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="v3-section-empty">
                  <span>{I.clock}</span>
                  <div><strong>暂无开奖记录</strong><small>完成开奖后将在这里显示</small></div>
                </div>
              )}
            </section>
            <div className="bottom-space" />
          </div>
        </section>

        <section className={`root-view ${c.activeTab === 'candidates' ? 'is-active' : ''}`} data-root-view="candidates" hidden={c.activeTab !== 'candidates'}>
          <div className="root-scroll">
            <header className="large-title">
              <span className={`title-status ${c.candidateLoadError || c.candidateWarningText ? 'warning' : c.hasCandidates ? '' : 'neutral'}`}><i /> {c.candidateLoadError ? '候选名单未更新' : c.candidateWarningText ? '名单范围需核对' : c.hasCandidates ? '名单已载入' : c.candidateLoadCompleted ? '候选检查已完成' : '尚未载入候选'}</span>
              <h1>候选名单</h1>
              <p>{c.hasCandidates ? c.candidateLoadError ? `刷新未完成：${c.candidateLoadError}` : `${c.eligible.length.toLocaleString()} 人符合当前筛选规则 · ${c.candidateFreshnessText}` : c.candidateLoadError ? c.candidateLoadError : c.candidateLoadCompleted ? '当前来源没有返回可见候选，可更新名单或改用手动导入' : '从微博载入，也可手动填写或导入文件'}</p>
            </header>

            <section className="content-section v3-source-section">
              <SectionTitle title="载入名单" action={c.hasCandidates && c.source !== 'manual' ? '刷新' : ''} onAction={() => c.safeLoadCandidates({ jumpAfterLoad: false, forceRefresh: true })} />
              <div className="segmented-control v3-source-control" role="group" aria-label="候选来源" style={{ '--segment-index': sourceSegmentIndex }}>
                <span className="segmented-highlight" aria-hidden="true" />
                {SOURCE_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    className={c.source === value ? 'is-active' : ''}
                    aria-pressed={c.source === value}
                    onClick={() => {
                      if (c.setSource(value)) c.clearResult('候选来源已更新，请重新开奖。');
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {c.source === 'mobile' && (
                <div className="v3-source-form">
                  <label className="v3-link-field">
                    <span className="sr-only">微博链接、mid 或 bid</span>
                    <input
                      ref={c.candidateStatusInputRef}
                      value={c.statusUrl}
                      onChange={(event) => c.updateStatusInput(event.target.value)}
                      onPaste={c.handleStatusPaste}
                      name="candidateStatusUrl"
                      inputMode="url"
                      autoComplete="off"
                      placeholder="微博正文链接、mid 或 bid"
                    />
                  </label>
                  <button className="v3-solid-action v3-primary-action" type="button" onClick={c.pasteAndLoadCandidates} disabled={c.isLoading}>
                    {c.isLoading ? I.refresh : I.link}
                    {c.isLoading ? '正在载入' : c.statusUrl.trim() ? '载入候选' : '粘贴并载入'}
                  </button>
                  <div className="v3-cookie-row">
                    <span className="row-icon blue">{I.shield}</span>
                    <span><strong>{c.accountStatusText}</strong><small>服务器登录态优先</small></span>
                    <button type="button" onClick={() => c.loadCookieStatus(false)}>刷新</button>
                  </div>
                  <button className="v3-disclosure" type="button" onClick={() => c.setManualCookieOpen((value) => !value)} aria-expanded={c.manualCookieOpen}>
                    <span>备用 Cookie</span>
                    <span>{c.manualCookieOpen ? '收起' : '展开'} {I.chevron}</span>
                  </button>
                  {c.manualCookieOpen && (
                    <>
                      <textarea
                        className="v3-textarea"
                        value={c.mobileCookie}
                        onChange={(event) => c.setMobileCookie(event.target.value)}
                        name="mobileCookie"
                        aria-label="备用微博 Cookie"
                        placeholder="仅在服务器登录态不可用时尝试"
                      />
                      <p className="v3-credential-notice">
                        备用 Cookie 会发送至本应用服务器，仅在当前任务中处理。请勿在公共设备填写。
                        <button type="button" onClick={() => c.openLegalDocument('privacy')}>查看隐私政策</button>
                      </p>
                    </>
                  )}
                </div>
              )}

              {c.source === 'manual' && (
                <div className="v3-source-form">
                  <textarea
                    className="v3-textarea v3-list-input"
                    value={c.manualInput}
                    onChange={(event) => c.updateManualInput(event.target.value)}
                    name="manualCandidateInput"
                    aria-label="手动候选名单"
                    placeholder="每行一个昵称；CSV 建议使用 uid,screenName 表头。"
                  />
                  <div className="v3-action-row">
                    <label className="v3-file-action">
                      {I.upload}
                      <span>选择文件</span>
                      <input type="file" accept=".csv,.txt,.tsv,.json,text/csv,text/plain,application/json" onChange={c.importCandidateFile} />
                    </label>
                    <button type="button" onClick={() => c.safeLoadCandidates({ jumpAfterLoad: false })}>替换名单</button>
                    <button type="button" onClick={c.addManualNames}>追加</button>
                  </div>
                </div>
              )}

              {c.source === 'official' && (
                <div className="v3-source-form">
                  <label className="v3-link-field">
                    <span className="sr-only">微博链接、mid 或 bid</span>
                    <input
                      value={c.statusUrl}
                      onChange={(event) => c.updateStatusInput(event.target.value)}
                      name="officialStatusUrl"
                      inputMode="url"
                      autoComplete="off"
                      placeholder="微博正文链接、mid 或 bid"
                    />
                  </label>
                  <label className="v3-link-field">
                    <span className="sr-only">官方访问令牌</span>
                    <input
                      value={c.accessToken}
                      onChange={(event) => c.setAccessToken(event.target.value)}
                      name="accessToken"
                      type="password"
                      placeholder="输入官方访问令牌"
                    />
                  </label>
                  <p className="v3-credential-notice">
                    访问令牌会发送至本应用服务器，仅用于当前任务。请使用微博官方授权获得的令牌。
                    <button type="button" onClick={() => c.openLegalDocument('privacy')}>查看隐私政策</button>
                  </p>
                  <button className="v3-solid-action v3-primary-action" type="button" onClick={() => c.safeLoadCandidates({ jumpAfterLoad: false, forceRefresh: c.shouldForceCandidateRefresh(c.statusUrl) })} disabled={c.isLoading}>
                    {I.download}
                    通过官方接口载入
                  </button>
                </div>
              )}

              <CandidateLoadProgress progress={c.progress} isLoading={c.isLoading} onCancel={c.cancelCandidateLoad} />
            </section>

            {(c.candidateLoadError || c.candidateWarningText) && (
              <div className={`v3-candidate-warning ${c.candidateLoadError ? 'v3-candidate-warning-error' : ''}`.trim()} role="note">
                {I.alert}
                <div>
                  <strong>{c.candidateLoadError ? '候选名单未更新' : '名单范围需要核对'}</strong>
                  <small>{c.candidateLoadError || c.candidateWarningText}</small>
                </div>
              </div>
            )}

            {c.hasCandidates && (
              <>
                <div className="search-field">
                  {I.users}
                  <input
                    type="search"
                    value={c.candidateQuery}
                    onChange={(event) => c.setCandidateQuery(event.target.value)}
                    placeholder="搜索昵称或 UID"
                    aria-label="搜索候选"
                    name="candidateSearch"
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <button type="button" onClick={() => c.setShowFilters(true)} aria-label="筛选候选">{I.listChecks}</button>
                </div>
                <div className="segmented-control" role="group" aria-label="候选范围" style={{ '--segment-index': candidateSegmentIndex }}>
                  <span className="segmented-highlight" aria-hidden="true" />
                  <button type="button" className={c.candidateSegment === 'eligible' ? 'is-active' : ''} aria-pressed={c.candidateSegment === 'eligible'} onClick={() => c.setCandidateSegment('eligible')}>可抽 {c.eligible.length}</button>
                  <button type="button" className={c.candidateSegment === 'all' ? 'is-active' : ''} aria-pressed={c.candidateSegment === 'all'} onClick={() => c.setCandidateSegment('all')}>全部 {c.candidates.length}</button>
                  <button type="button" className={c.candidateSegment === 'excluded' ? 'is-active' : ''} aria-pressed={c.candidateSegment === 'excluded'} onClick={() => c.setCandidateSegment('excluded')}>已排除 {excludedCandidates.length}</button>
                </div>
              </>
            )}

            <section className="content-section candidate-section">
              <SectionTitle
                title={query ? `搜索结果 · ${matchingCandidates.length.toLocaleString()}` : '候选用户'}
                action={c.hasCandidates ? '导出当前' : ''}
                onAction={() => c.exportCandidates(matchingCandidates, evaluationByCandidate, {
                  segment: c.candidateSegment,
                  query,
                })}
              />
              {visibleCandidates.length ? (
                <div className="people-list">
                  {visibleCandidates.map((candidate, index) => {
                    const entry = evaluationByCandidate.get(candidate) || {
                      candidate,
                      eligible: true,
                      reasonLabel: '',
                    };
                    return (
                      <button
                        type="button"
                        key={candidate.id || candidate.uid || candidate.screenName || index}
                        onClick={() => setSelectedCandidateEntry(entry)}
                      >
                        <CandidateAvatar candidate={candidate} className="candidate-avatar-list" apiBase={c.apiBase} decorative />
                        <span>
                          <strong>{candidate.screenName || candidate.uid || `候选用户 ${index + 1}`}</strong>
                          <small>{candidate.uid ? `UID ${candidate.uid}` : friendlyProviderText(candidate.source) || '候选名单'}</small>
                        </span>
                        <span className={entry.eligible ? 'status-badge' : 'status-badge is-excluded'}>
                          {entry.eligible ? '可抽' : entry.reasonLabel}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="v3-section-empty v3-candidate-empty">
                  <span>{I.users}</span>
                  <div><strong>{c.hasCandidates ? '没有匹配的候选用户' : c.candidateLoadError ? '候选载入未完成' : c.candidateLoadCompleted ? '没有找到可见候选' : '候选名单为空'}</strong><small>{c.hasCandidates ? '调整搜索或筛选条件后再查看' : c.candidateLoadError ? '请重新载入候选名单后再继续' : c.candidateLoadCompleted ? '可以更新当前来源，或切换为手动名单' : '载入名单后，候选用户会显示在这里'}</small></div>
                </div>
              )}
              {remainingCandidates > 0 && (
                <div className="candidate-load-more">
                  <span>已显示 {visibleCandidates.length.toLocaleString()} / {matchingCandidates.length.toLocaleString()}</span>
                  <button
                    type="button"
                    onClick={() => setCandidateLimit((current) => current + CANDIDATE_BATCH_SIZE)}
                  >
                    继续显示 {Math.min(CANDIDATE_BATCH_SIZE, remainingCandidates).toLocaleString()} 人
                  </button>
                </div>
              )}
              {!remainingCandidates && searchOnlyCandidates > 0 && (
                <div className="candidate-load-more" role="note">
                  <span>已显示前 {CANDIDATE_RENDER_LIMIT.toLocaleString()} 人，搜索或导出可查看完整名单</span>
                </div>
              )}
            </section>
            <div className="bottom-space" />
          </div>
        </section>

        <section className={`root-view ${c.activeTab === 'history' ? 'is-active' : ''}`} data-root-view="history" hidden={c.activeTab !== 'history'}>
          <div className="root-scroll">
            <header className="large-title">
              <span className="title-status neutral"><i /> {c.historyStorageAvailable ? '本机保存的开奖结果' : '当前页面的开奖结果'}</span>
              <h1>开奖记录</h1>
              <p>{c.drawHistory.length ? `共 ${c.drawHistory.length} 次开奖，${totalHistoricWinners} 名获奖用户${c.drawHistory.length >= DRAW_HISTORY_LIMIT ? ` · 保留最近 ${DRAW_HISTORY_LIMIT} 条` : ''}` : c.historyStorageAvailable ? '完成开奖后，记录会保存在当前浏览器' : '本机存储不可用，完成开奖后仅在当前页面显示'}</p>
            </header>

            <section className="history-summary">
              <div><span>总开奖</span><strong>{c.drawHistory.length}</strong><small>次</small></div>
              <div><span>获奖用户</span><strong>{totalHistoricWinners}</strong><small>人</small></div>
              <div><span>最近开奖</span><strong>{historyDateParts(c.drawHistory[0]?.time).compact}</strong><small>{historyDateParts(c.drawHistory[0]?.time).time}</small></div>
            </section>

            <section className="content-section">
              <SectionTitle title={historySearch ? `搜索记录 · ${filteredHistory.length}` : '全部记录'} />
              {c.drawHistory.length > 2 && (
                <div className="search-field history-search-field">
                  {I.clock}
                  <input
                    type="search"
                    value={c.historyQuery}
                    onChange={(event) => c.setHistoryQuery(event.target.value)}
                    placeholder="搜索奖项、昵称或微博链接"
                    aria-label="搜索开奖记录"
                    name="historySearch"
                    autoComplete="off"
                  />
                  {historySearch && (
                    <button type="button" aria-label="清除记录搜索" onClick={() => c.setHistoryQuery('')}>{I.close}</button>
                  )}
                </div>
              )}
              {visibleHistory.length ? (
                <>
                  <div className="history-list">
                    {visibleHistory.map((item, index) => {
                      const date = historyDateParts(item.time);
                      return (
                        <button
                          type="button"
                          key={`${item.time}-${index}`}
                          onClick={() => c.setSelectedReceipt(item)}
                        >
                          <span className={`date-block ${index % 3 === 1 ? 'blue' : index % 3 === 2 ? 'mint' : ''}`}>
                            <strong>{date.day}</strong><small>{date.month} 月</small>
                          </span>
                          <span><strong>{item.results?.[0]?.prize?.name || '微博转发抽奖'}</strong><small>{item.results?.length || 1} 个奖项 · {item.total} 名获奖用户</small></span>
                          {I.chevron}
                        </button>
                      );
                    })}
                  </div>
                  {filteredHistory.length > 3 && (
                    <button className="show-more-button" type="button" onClick={() => c.setHistoryExpanded((value) => !value)}>
                      {c.historyExpanded ? '收起较早记录' : `展开全部 ${filteredHistory.length} 条`}
                    </button>
                  )}
                </>
              ) : (
                <div className="v3-section-empty v3-history-empty">
                  <span>{I.clock}</span>
                  <div><strong>{historySearch ? '没有匹配的记录' : '暂无开奖记录'}</strong><small>{historySearch ? '换个奖项、昵称或链接关键词试试' : '完成一次抽奖后再来查看'}</small></div>
                </div>
              )}
            </section>
            <div className="bottom-space" />
          </div>
        </section>

        <section className={`root-view ${c.activeTab === 'more' ? 'is-active' : ''}`} data-root-view="more" hidden={c.activeTab !== 'more'}>
          <div className="root-scroll">
            <header className="large-title more-title">
              <span className="title-status neutral"><i /> 应用与支持</span>
              <h1>更多</h1>
              <p>连接设置、数据管理与使用说明</p>
            </header>

            <button className="app-summary" type="button" onClick={() => c.openLegalDocument('about')}>
              <img src={publicAsset('avatar-96.webp')} alt="" width="72" height="72" />
              <span><strong>微博转发抽奖</strong><small>版本 {APP_VERSION} · by.sameko</small></span>
              <em>关于</em>
              {I.chevron}
            </button>

            <section className="content-section">
              <SectionTitle title="数据与连接" />
              <div className="grouped-list">
                <AppListRow icon={I.clock} tone="coral" title="本机记录" detail={c.historyStorageAvailable ? `查看当前浏览器最近 ${DRAW_HISTORY_LIMIT} 条开奖记录` : '本机存储不可用，仅保留当前页面记录'} value={`${c.drawHistory.length} 条`} onClick={() => switchTab('history', { focus: true })} />
                <AppListRow icon={I.archive} tone="lilac" title="记录备份" detail="导出或恢复当前浏览器的开奖记录" onClick={() => c.openSettings('records')} />
                <AppListRow icon={I.shield} title="备用 Cookie" detail="服务器登录态不可用时用于当前载入" value={c.mobileCookie.trim() ? '已填写' : '未填写'} onClick={() => c.openSettings('cookie')} />
                <AppListRow icon={I.refresh} tone="mint" title="后端连接" detail="候选载入、开奖记录与头像服务" value={c.serviceStatusText} onClick={() => c.openSettings('backend')} />
              </div>
            </section>

            <section className="content-section">
              <SectionTitle title="偏好与帮助" />
              <div className="grouped-list">
                <AppListRow icon={I.settings} tone="gray" title="数据设置" detail="备份或清理当前浏览器的数据" onClick={() => c.openSettings('records')} />
                <AppListRow icon={I.book} tone="coral" title="使用教程" detail="从候选载入到保存结果" onClick={() => c.setShowGuide(true)} />
                <AppListRow icon={I.feedback} tone="mint" title="意见反馈" detail="提交建议或报告使用问题" onClick={() => c.openFeedback()} />
                <AppListRow icon={I.info} tone="lilac" title="关于此应用" detail="用途、版本与服务关系" onClick={() => c.openLegalDocument('about')} />
              </div>
            </section>

            <section className="content-section">
              <SectionTitle title="法律与许可" />
              <div className="grouped-list">
                <AppListRow icon={I.alert} tone="coral" title="免责声明" detail="服务边界与使用责任" onClick={() => c.openLegalDocument('disclaimer')} />
                <AppListRow icon={I.shield} title="隐私政策" detail="Cookie、候选与记录如何处理" onClick={() => c.openLegalDocument('privacy')} />
                <AppListRow icon={I.file} tone="mint" title="用户协议" detail="使用规则与禁止事项" onClick={() => c.openLegalDocument('terms')} />
                <AppListRow icon={I.info} tone="lilac" title="版权说明" detail="应用、用户与平台内容" onClick={() => c.openLegalDocument('copyright')} />
                <AppListRow icon={I.file} tone="gray" title="第三方许可" detail="软件清单、版权与许可文本" onClick={() => c.openLegalDocument('licenses')} />
              </div>
            </section>
            <div className="bottom-space" />
          </div>
        </section>
      </main>

      <nav className="root-tabbar glass" inert={contentInert ? '' : undefined} aria-label="主要导航" style={{ '--tab-index': tabIndex }}>
        <span className="tab-highlight" />
        <button data-tab-target="home" className={c.activeTab === 'home' ? 'is-active' : ''} type="button" aria-current={c.activeTab === 'home' ? 'page' : undefined} onClick={() => switchTab('home')}>
          {I.sparkles}<span>抽奖</span>
        </button>
        <button data-tab-target="candidates" className={c.activeTab === 'candidates' ? 'is-active' : ''} type="button" aria-current={c.activeTab === 'candidates' ? 'page' : undefined} onClick={() => switchTab('candidates')}>
          {I.users}<span>名单</span>
        </button>
        <button data-tab-target="history" className={c.activeTab === 'history' ? 'is-active' : ''} type="button" aria-current={c.activeTab === 'history' ? 'page' : undefined} onClick={() => switchTab('history')}>
          {I.clock}<span>记录</span>
        </button>
        <button data-tab-target="more" className={c.activeTab === 'more' ? 'is-active' : ''} type="button" aria-current={c.activeTab === 'more' ? 'page' : undefined} onClick={() => switchTab('more')}>
          {I.more}<span>更多</span>
        </button>
      </nav>

      {c.showGuide && <GuideSheet onClose={() => c.setShowGuide(false)} />}
      {c.showFeedback && <FeedbackSheet key={c.feedbackInitialCategory} initialCategory={c.feedbackInitialCategory} onClose={() => c.setShowFeedback(false)} onSubmit={c.submitFeedback} />}
      {c.legalDocument && <LegalSheet document={c.legalDocument} onClose={() => c.setLegalDocument(null)} onOpenPrivacyRequest={() => c.openFeedback('privacy')} onOpenUpdates={() => c.openLegalDocument('updates')} />}
      {c.showDrawConfirm && (
        <DrawConfirmSheet
          controller={c}
          onClose={() => c.setShowDrawConfirm(false)}
          onConfirm={confirmDraw}
          onPractice={practiceDraw}
          onRefresh={() => c.safeLoadCandidates({ jumpAfterLoad: false, forceRefresh: true })}
        />
      )}

      {c.showSourceEditor && (
        <SheetFrame
          title="候选来源"
          subtitle={sourceDetail}
          icon={I.link}
          onClose={() => c.setShowSourceEditor(false)}
          className="v3-editor-sheet v3-source-sheet"
          returnFocusId="candidate-source-row"
        >
          {(close) => (
            <>
          <div className="segmented-control v3-source-control" role="group" aria-label="候选来源" style={{ '--segment-index': sourceSegmentIndex }}>
            <span className="segmented-highlight" aria-hidden="true" />
            {SOURCE_OPTIONS.map(({ value, label }) => (
              <button
              key={value}
              type="button"
              className={c.source === value ? 'is-active' : ''}
              aria-pressed={c.source === value}
              onClick={() => {
                  if (c.setSource(value)) c.clearResult();
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {c.source === 'mobile' && (
            <div className="v3-source-form v3-sheet-source-form">
              <div className="v3-sheet-callout">
                <span className="row-icon blue">{I.link}</span>
                <div><strong>微博链接载入</strong><small>读取当前登录态及微博接口可见的转发</small></div>
              </div>
              <label className="v3-link-field">
                <span className="sr-only">微博链接、mid 或 bid</span>
                <input
                  ref={c.sourceSheetStatusInputRef}
                  value={c.statusUrl}
                  onChange={(event) => c.updateStatusInput(event.target.value)}
                  onPaste={c.handleStatusPaste}
                  name="sourceSheetStatusUrl"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="微博正文链接、mid 或 bid"
                />
              </label>
              <button className="v3-pearl-action v3-primary-action" type="button" onClick={c.pasteAndLoadCandidates} disabled={c.isLoading}>
                <span className="v3-pearl-icon">{c.isLoading ? I.refresh : I.link}</span>
                <span className="v3-pearl-copy">
                  <strong>{c.isLoading ? '正在载入候选' : c.statusUrl.trim() ? '载入候选' : '粘贴链接并载入'}</strong>
                  <small>自动识别微博正文链接、mid 或 bid</small>
                </span>
                <span className="v3-pearl-arrow">{I.chevron}</span>
              </button>
              <div className="v3-cookie-row">
                <span className="row-icon blue">{I.shield}</span>
                <span><strong>{c.accountStatusText}</strong><small>服务器登录态优先</small></span>
                <button type="button" onClick={() => c.loadCookieStatus(false)}>刷新</button>
              </div>
              <button className="v3-disclosure" type="button" onClick={() => c.setManualCookieOpen((value) => !value)} aria-expanded={c.manualCookieOpen}>
                <span>备用 Cookie</span>
                <span>{c.manualCookieOpen ? '收起' : '展开'} {I.chevron}</span>
              </button>
              {c.manualCookieOpen && (
                <>
                  <textarea
                    className="v3-textarea"
                    value={c.mobileCookie}
                    onChange={(event) => c.setMobileCookie(event.target.value)}
                    name="sourceSheetMobileCookie"
                    aria-label="备用微博 Cookie"
                    placeholder="仅在服务器登录态不可用时尝试"
                  />
                  <p className="v3-credential-notice">
                    备用 Cookie 会发送至本应用服务器，仅在当前任务中处理。请勿在公共设备填写。
                    <button type="button" onClick={() => c.openLegalDocument('privacy')}>查看隐私政策</button>
                  </p>
                </>
              )}
            </div>
          )}

          {c.source === 'manual' && (
            <div className="v3-source-form v3-sheet-source-form">
              <div className="v3-sheet-callout">
                <span className="row-icon coral">{I.users}</span>
                <div><strong>手动名单</strong><small>每行一个昵称，也可导入带表头的 CSV、TSV 或 JSON</small></div>
              </div>
              <textarea
                className="v3-textarea v3-list-input"
                value={c.manualInput}
                onChange={(event) => c.updateManualInput(event.target.value)}
                name="sourceSheetManualCandidates"
                aria-label="弹窗手动候选名单"
                placeholder="每行一个昵称；CSV 建议使用 uid,screenName 表头。"
              />
              <div className="v3-action-row">
                <label className="v3-file-action">
                  {I.upload}
                  <span>选择文件</span>
                  <input type="file" accept=".csv,.txt,.tsv,.json,text/csv,text/plain,application/json" onChange={c.importCandidateFile} />
                </label>
                <button type="button" onClick={() => c.safeLoadCandidates({ jumpAfterLoad: false })}>替换名单</button>
                <button type="button" onClick={c.addManualNames}>追加</button>
              </div>
            </div>
          )}

          {c.source === 'official' && (
            <div className="v3-source-form v3-sheet-source-form">
              <div className="v3-sheet-callout">
                <span className="row-icon mint">{I.shield}</span>
                <div><strong>官方接口</strong><small>使用微博官方访问令牌载入候选</small></div>
              </div>
              <label className="v3-link-field">
                <span className="sr-only">微博链接、mid 或 bid</span>
                <input
                  value={c.statusUrl}
                  onChange={(event) => c.updateStatusInput(event.target.value)}
                  name="sourceSheetOfficialStatusUrl"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="微博正文链接、mid 或 bid"
                />
              </label>
              <label className="v3-link-field">
                <span className="sr-only">官方访问令牌</span>
                <input
                  value={c.accessToken}
                  onChange={(event) => c.setAccessToken(event.target.value)}
                  name="sourceSheetAccessToken"
                  type="password"
                  placeholder="输入官方访问令牌"
                />
              </label>
              <p className="v3-credential-notice">
                访问令牌会发送至本应用服务器，仅用于当前任务。请使用微博官方授权获得的令牌。
                <button type="button" onClick={() => c.openLegalDocument('privacy')}>查看隐私政策</button>
              </p>
              <button className="v3-pearl-action v3-primary-action" type="button" onClick={() => c.safeLoadCandidates({ jumpAfterLoad: false, forceRefresh: c.shouldForceCandidateRefresh(c.statusUrl) })} disabled={c.isLoading}>
                <span className="v3-pearl-icon">{c.isLoading ? I.refresh : I.download}</span>
                <span className="v3-pearl-copy"><strong>{c.isLoading ? '正在载入候选' : '通过官方接口载入'}</strong><small>令牌仅用于当前载入任务</small></span>
                <span className="v3-pearl-arrow">{I.chevron}</span>
              </button>
            </div>
          )}

          <button type="button" className="flow-sheet-primary v3-primary-action" onClick={() => close()}>完成</button>
            </>
          )}
        </SheetFrame>
      )}

      {c.showPrizeEditor && (
        <SheetFrame
          title="奖项设置"
          subtitle={`${c.normalizedPrizes.length} 个奖项 · ${c.totalSlots} 个名额`}
          icon={I.gift}
          onClose={() => c.setShowPrizeEditor(false)}
          className="v3-editor-sheet"
          initialFocusRef={c.firstPrizeNameRef}
        >
          {(close) => (
            <>
          <div className="v3-sheet-toolbar">
            <span>按顺序依次抽取</span>
            <button
              type="button"
              onClick={c.addPrize}
              disabled={c.prizes.length >= MAX_DRAW_RESULT_GROUPS}
              title={c.prizes.length >= MAX_DRAW_RESULT_GROUPS ? `最多 ${MAX_DRAW_RESULT_GROUPS} 个奖项` : undefined}
            >{I.plus} 添加奖项</button>
          </div>
          <div className="v3-prize-list">
            {c.prizes.map((prize, index) => (
              <section className="v3-prize-item" key={index}>
                <span className="v3-prize-number" style={{ '--prize-color': prize.color || COLORS[index % COLORS.length] }}>{index + 1}</span>
                <div>
                  <label>
                    <span>奖项名称</span>
                    <input
                      ref={index === 0 ? c.firstPrizeNameRef : null}
                      value={prize.name}
                      onChange={(event) => c.updatePrize(index, { name: event.target.value })}
                      name={`prizeName-${index}`}
                      placeholder="例如：一等奖 / 幸运奖"
                    />
                  </label>
                  <div className="v3-prize-footer">
                    <span>中奖人数</span>
                    <div className="v3-stepper">
                      <button
                        type="button"
                        aria-label={`减少第 ${index + 1} 个奖项名额`}
                        onClick={() => c.updatePrizeCount(index, Number(prize.count || 1) - 1)}
                        disabled={Number(prize.count || 1) <= 1}
                      >
                        {I.minus}
                      </button>
                      <input
                        type="number"
                        min="1"
                        max={MAX_DRAW_WINNERS}
                        inputMode="numeric"
                        value={prize.count}
                        onChange={(event) => c.updatePrizeCount(index, event.target.value)}
                        onBlur={() => c.commitPrizeCount(index)}
                        aria-label={`第 ${index + 1} 个奖项中奖人数`}
                      />
                      <button
                        type="button"
                        aria-label={`增加第 ${index + 1} 个奖项名额`}
                        onClick={() => c.updatePrizeCount(index, Number(prize.count || 1) + 1)}
                        disabled={Number(prize.count || 1) >= MAX_DRAW_WINNERS}
                      >
                        {I.plus}
                      </button>
                    </div>
                    <button
                      className="v3-delete-prize"
                      type="button"
                      aria-label={`删除第 ${index + 1} 个奖项`}
                      onClick={() => c.removePrize(index)}
                      disabled={c.prizes.length <= 1}
                    >
                      {I.trash}
                    </button>
                  </div>
                </div>
              </section>
            ))}
          </div>
          <div className="v3-prize-confirm-summary">
            <span>{I.users}<small>可抽候选</small><strong>{c.eligible.length.toLocaleString()} 人</strong></span>
            <span>{I.gift}<small>中奖名额</small><strong>{c.totalSlots} 人</strong></span>
          </div>
          <button
            type="button"
            className="flow-sheet-primary v3-primary-action v3-prize-confirm-button"
            onClick={() => {
              if (c.confirmDrawSetup()) close(() => c.setShowDrawConfirm(true));
            }}
            disabled={!c.hasCandidates || !c.candidateSourceReady}
          >
            {I.check}
            <span>{!c.hasCandidates ? '载入候选后确认' : c.candidateSourceReady ? '确认奖项设置' : '载入当前来源后确认'}</span>
          </button>
            </>
          )}
        </SheetFrame>
      )}

      {c.showFilters && (
        <FilterEditorSheet controller={c} onClose={() => c.setShowFilters(false)} />
      )}

      {c.showSettings && (
        <SheetFrame title="设置" subtitle="显示、数据与后端连接" icon={I.settings} onClose={() => c.setShowSettings(false)} className="v3-editor-sheet">
          {(close) => (
            <>
          <div className="flow-app-summary">
            <img src={publicAsset('avatar-96.webp')} alt="" width="72" height="72" />
            <div><strong>微博转发抽奖</strong><p>版本 {APP_VERSION} · by.sameko</p></div>
            <span>{c.accountStatusText}</span>
          </div>
          <h3 className="flow-settings-caption">动效</h3>
          <div className="flow-motion-setting">
            <div className="flow-motion-heading">
              <span>{I.sparkles}</span>
              <div>
                <strong>界面动效</strong>
                <small>{c.motionPreference === 'full' ? '播放完整页面、弹窗与开奖动效' : c.motionPreference === 'reduced' ? '保留状态反馈，减少大幅位移' : '遵循设备的动态效果设置'}</small>
              </div>
            </div>
            <div className="segmented-control motion-segmented" role="group" aria-label="开奖动效强度" style={{ '--segment-index': motionSegmentIndex }}>
              <span className="segmented-highlight" aria-hidden="true" />
              {MOTION_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={c.motionPreference === option.value ? 'is-active' : ''}
                  aria-pressed={c.motionPreference === option.value}
                  onClick={() => c.setMotionPreference(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <h3 className="flow-settings-caption" data-settings-section="records">记录与数据</h3>
          <div className="flow-settings-list">
            <button type="button" onClick={c.exportHistoryBackup} disabled={!c.drawHistory.length}>
              <span>{I.download}</span><div><strong>导出开奖记录</strong><small>备份当前浏览器最近 {DRAW_HISTORY_LIMIT} 条记录</small></div><em className="flow-settings-action-label is-neutral">导出</em>
            </button>
            <button type="button" onClick={() => c.historyImportInputRef.current?.click()}>
              <span>{I.archive}</span><div><strong>恢复开奖记录</strong><small>合并本应用导出的记录备份，不覆盖现有记录</small></div><em className="flow-settings-action-label is-neutral">选择文件</em>
            </button>
            <input ref={c.historyImportInputRef} type="file" accept="application/json,.json" hidden onChange={c.importHistoryBackup} />
            <button type="button" onClick={() => close(() => c.setConfirmAction({
              kind: 'current-draw',
              title: '清空当前抽奖？',
              message: '当前候选和尚未保存的结果会被移除，服务器开奖记录不受影响。',
            }))}>
              <span>{I.trash}</span><div><strong>清空当前抽奖</strong><small>移除当前候选与结果，不影响服务器记录</small></div><em className="flow-settings-action-label">清空</em>
            </button>
            <button type="button" onClick={() => { c.setMobileCookie(''); c.showStatus('已清空备用 Cookie。', 'success', { popup: true, title: '已清空' }); }}>
              <span>{I.shield}</span><div><strong>清除备用 Cookie</strong><small>不会修改服务器登录态</small></div><em className="flow-settings-action-label">清除</em>
            </button>
            <button type="button" onClick={() => close(() => c.setConfirmAction({
              kind: 'local-history',
              title: '清空本机记录？',
              message: '当前浏览器保存的开奖记录会被移除，服务器中的记录不会删除。',
            }))}>
              <span>{I.clock}</span><div><strong>清空本机记录</strong><small>仅移除当前浏览器中的开奖记录</small></div><em className="flow-settings-action-label">清空</em>
            </button>
          </div>
          <details
            className="flow-connection-details"
            data-settings-section="cookie"
            open={settingsDisclosures.cookie}
            onToggle={(event) => setSettingsDisclosures((current) => ({ ...current, cookie: event.currentTarget.open }))}
          >
            <summary><span><strong>备用 Cookie</strong><small>{c.accountStatusText}</small></span>{I.chevron}</summary>
            <div className="flow-settings-form">
              <label className="flow-field-block">
                <span>仅在服务器登录态不可用时尝试</span>
                <textarea
                  value={c.mobileCookie}
                  onChange={(event) => c.setMobileCookie(event.target.value)}
                  name="settingsMobileCookie"
                  autoComplete="off"
                  spellCheck="false"
                  placeholder="粘贴本人有权使用的微博 Cookie…"
                />
              </label>
              <p className="v3-credential-notice">仅在当前任务中处理，任务结束后清除，不写入服务器 Cookie 池。</p>
            </div>
          </details>
          <details
            className="flow-connection-details"
            data-settings-section="backend"
            open={settingsDisclosures.backend}
            onToggle={(event) => setSettingsDisclosures((current) => ({ ...current, backend: event.currentTarget.open }))}
          >
            <summary><span><strong>后端连接</strong><small>{c.serviceStatusText}</small></span>{I.chevron}</summary>
            <div className="flow-settings-form">
              <label className="flow-field-block"><span>已配置的后端地址</span><input value={c.apiBaseInput} onChange={(event) => c.setApiBaseInput(event.target.value)} onBlur={() => c.commitApiBase()} onKeyDown={(event) => { if (event.key === 'Enter') c.commitApiBase(); }} placeholder="仅支持预配置地址或本机地址" /></label>
              <label className="flow-field-block"><span>访问密钥（可选）</span><input value={c.apiKey} onChange={(event) => c.setApiKey(event.target.value)} type="password" placeholder="公开模式不用填写" /></label>
              <div className="flow-settings-actions">
                <button type="button" onClick={c.testApiConnection}>测试连接</button>
                <button type="button" onClick={() => { c.setApiBaseInput(''); c.setApiBase(''); c.setApiKey(''); c.showStatus('已改用当前站点的后端。', 'success', { popup: true, title: '已切换' }); }}>使用当前站点</button>
              </div>
            </div>
          </details>
          <button type="button" className="flow-sheet-primary v3-primary-action" onClick={() => close()}>完成</button>
            </>
          )}
        </SheetFrame>
      )}

      <DrawResultSheet
        key={c.selectedReceipt?.drawnAt || 'no-result'}
        receipt={c.selectedReceipt}
        apiBase={c.apiBase}
        isCapturing={c.isCapturing}
        isSyncing={c.syncingReceiptIds.has(c.selectedReceipt?.id)}
        historyStorageAvailable={c.historyStorageAvailable}
        onClose={() => c.setSelectedReceipt(null)}
        onSaveImage={() => c.createShareImage(c.selectedReceipt)}
        onCopyPost={(template) => c.copyReceiptPost(c.selectedReceipt, template)}
        onCopyFairness={() => c.copyReceiptFairness(c.selectedReceipt)}
        onCopyWinners={() => c.copyReceiptWinners(c.selectedReceipt)}
        onExportWinners={() => c.exportReceiptWinners(c.selectedReceipt)}
        onRetrySave={() => c.retrySaveReceipt(c.selectedReceipt)}
      />
      <CandidateDetailSheet
        entry={selectedCandidateEntry}
        apiBase={c.apiBase}
        onClose={() => setSelectedCandidateEntry(null)}
        onCopy={c.copyToClipboard}
      />
    </div>
  );
}

function App() {
  const [source, setSource] = useState('mobile');
  const [statusUrl, setStatusUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [mobileCookie, setMobileCookie] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [historyUids, setHistoryUids] = useState(new Set());
  const [prizes, setPrizes] = useState([...DEFAULT_PRIZES]);
  const [keyword, setKeyword] = useState('');
  const [mentionMin, setMentionMin] = useState(0);
  const [blocklist, setBlocklist] = useState('');
  const [uniqueByUser, setUniqueByUser] = useState(true);
  const [excludePrevious, setExcludePrevious] = useState(true);
  const [results, setResults] = useState([]);
  const [lastAudit, setLastAudit] = useState(null);
  const [sourceMeta, setSourceMeta] = useState(null);
  const [loadedSource, setLoadedSource] = useState('');
  const [sourceInputDirty, setSourceInputDirty] = useState(false);
  const [candidateLoadError, setCandidateLoadError] = useState('');
  const [currentStatusId, setCurrentStatusId] = useState('');
  const [currentStatusUrl, setCurrentStatusUrl] = useState('');
  const [drawCount, setDrawCount] = useState(null);
  const [drawCountStatus, setDrawCountStatus] = useState('idle');
  const [cookieInfo, setCookieInfo] = useState({ hasCookie: false, cookieCount: 0, lastValidAt: '' });
  const [status, setStatus] = useState('等待载入候选。');
  const [statusTone, setStatusTone] = useState('neutral');
  const [progress, setProgress] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [rollingCandidate, setRollingCandidate] = useState(null);
  const [phase, setPhase] = useState('');
  const [drawHistory, setDrawHistory] = useState(() => readDrawHistory());
  const [historyStorageAvailable, setHistoryStorageAvailable] = useState(true);
  const [historyQuery, setHistoryQuery] = useState('');
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [pendingReceipt, setPendingReceipt] = useState(null);
  const [syncingReceiptIds, setSyncingReceiptIds] = useState(() => new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState('overview');
  const [showGuide, setShowGuide] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackInitialCategory, setFeedbackInitialCategory] = useState('suggestion');
  const [legalDocument, setLegalDocument] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [activeTab, setActiveTab] = useState('home');
  const [showSourceEditor, setShowSourceEditor] = useState(false);
  const [showPrizeEditor, setShowPrizeEditor] = useState(false);
  const [showDrawConfirm, setShowDrawConfirm] = useState(false);
  const [confirmedSetup, setConfirmedSetup] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [candidateSegment, setCandidateSegment] = useState('eligible');
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [manualCookieOpen, setManualCookieOpen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [motionPreference, setMotionPreference] = useState(initialMotionPreference);
  const [cooldownStorageAvailable, setCooldownStorageAvailable] = useState(canUseLocalStorage);
  const [apiBase, setApiBase] = useState(initialApiBase);
  const [apiBaseInput, setApiBaseInput] = useState(initialApiBase);
  const [apiKey, setApiKey] = useState('');
  const [apiHealth, setApiHealth] = useState('checking');
  const [cookieHealth, setCookieHealth] = useState('checking');
  const firstPrizeNameRef = useRef(null);
  const homeStatusInputRef = useRef(null);
  const candidateStatusInputRef = useRef(null);
  const sourceSheetStatusInputRef = useRef(null);
  const historyImportInputRef = useRef(null);
  const drawGuardRef = useRef(null);
  const drawTabLockRef = useRef(null);
  const repostLoadRef = useRef(null);
  const drawOperationRef = useRef(null);
  const drawSyncControllersRef = useRef(new Set());
  const taskRevisionRef = useRef(0);
  const candidateLoadRevisionRef = useRef(0);
  const mountedRef = useRef(true);
  const selectedReceiptRef = useRef(null);
  const drawHistoryRef = useRef(drawHistory);
  const manualDrawSequenceRef = useRef(0);
  const candidateLoadStartRef = useRef(false);
  const drawStartRef = useRef(false);
  const manualFileReadRef = useRef(false);
  const capturingRef = useRef(false);
  const progressClearTimerRef = useRef(null);
  const drawCountRequestRef = useRef(0);
  const cookieStatusRequestRef = useRef(0);
  const apiHealthRequestRef = useRef(0);
  const historyStorageNoticeRef = useRef('');

  function invalidateDrawContext() {
    taskRevisionRef.current += 1;
    candidateLoadRevisionRef.current += 1;
  }

  function isCurrentCandidateLoad(revision, operation = null) {
    return mountedRef.current
      && candidateLoadRevisionRef.current === revision
      && (!operation || repostLoadRef.current === operation);
  }

  function focusStatusInput() {
    const preferred = showSourceEditor
      ? sourceSheetStatusInputRef.current
      : activeTab === 'candidates'
        ? candidateStatusInputRef.current
        : homeStatusInputRef.current;
    preferred?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    taskRevisionRef.current += 1;
  }, [source, statusUrl, candidates]);

  useLayoutEffect(() => {
    selectedReceiptRef.current = selectedReceipt;
  }, [selectedReceipt]);

  useLayoutEffect(() => {
    drawHistoryRef.current = drawHistory;
  }, [drawHistory]);

  useLayoutEffect(() => {
    const next = nextManualDrawNumber(drawHistory);
    if (next !== null) {
      manualDrawSequenceRef.current = Math.max(manualDrawSequenceRef.current, next - 1);
    }
  }, [drawHistory]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      candidateLoadRevisionRef.current += 1;
      const guard = drawGuardRef.current;
      if (guard) releaseDrawGuard(window.localStorage, guard.scope, guard.token);
      drawTabLockRef.current?.release();
      drawOperationRef.current?.abort();
      for (const controller of drawSyncControllersRef.current) controller.abort();
      drawSyncControllersRef.current.clear();
      const repostLoad = repostLoadRef.current;
      if (repostLoad) {
        repostLoad.cancelIntent = true;
        if (repostLoad.cancelServer) {
          repostLoad.cancelServer();
          repostLoad.controller.abort();
        }
      }
      window.clearTimeout(progressClearTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const hasUnsavedManualList = source === 'manual' && sourceInputDirty && manualInput.trim();
    if (!isLoading && !isDrawing && !hasUnsavedManualList) return undefined;
    const warnBeforeLeaving = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [isDrawing, isLoading, manualInput, source, sourceInputDirty]);

  const normalizedPrizes = useMemo(() => prizes
    .map((prize, index) => ({
      ...prize,
      name: String(prize.name || '').trim(),
      count: Math.max(0, Math.floor(Number(prize.count || 0))),
      color: prize.color || COLORS[index % COLORS.length],
    }))
    .filter((prize) => prize.name && prize.count > 0), [prizes]);
  const totalSlots = normalizedPrizes.reduce((sum, prize) => sum + prize.count, 0);

  const rules = useMemo(() => {
    const blocked = new Set(blocklist.split(/\r?\n|,/).map((item) => item.trim().toLowerCase()).filter(Boolean));
    return {
      keyword: keyword.trim().toLowerCase(),
      mentionMin: normalizeMentionMin(mentionMin),
      uniqueByUser,
      excludePrevious,
      blocked,
    };
  }, [keyword, mentionMin, uniqueByUser, excludePrevious, blocklist]);

  const candidateEvaluations = useMemo(
    () => evaluateCandidateEligibility(candidates, rules, historyUids),
    [candidates, rules, historyUids],
  );
  const eligible = useMemo(
    () => candidateEvaluations.filter((entry) => entry.eligible).map((entry) => entry.candidate),
    [candidateEvaluations],
  );
  const candidateSummary = useMemo(
    () => summarizeCandidateEligibility(candidateEvaluations),
    [candidateEvaluations],
  );

  const winners = results.flatMap((item) => item.winners);
  const candidateSourceReady = Boolean(
    candidates.length
    && loadedSource === source
    && !sourceInputDirty
    && !candidateLoadError,
  );
  const drawSetupConfirmed = Boolean(
    candidateSourceReady
    && confirmedSetup
    && confirmedSetup.candidates === candidates
    && confirmedSetup.prizes === prizes
    && confirmedSetup.source === source
    && confirmedSetup.statusId === currentStatusId
    && confirmedSetup.statusUrl === currentStatusUrl
    && confirmedSetup.keyword === keyword
    && confirmedSetup.mentionMin === rules.mentionMin
    && confirmedSetup.blocklist === blocklist
    && confirmedSetup.uniqueByUser === uniqueByUser
    && confirmedSetup.excludePrevious === excludePrevious
    && confirmedSetup.eligibleCount === eligible.length,
  );
  const isBusy = isLoading || isDrawing;
  const cooldownPersistent = source === 'manual'
    ? true
    : cooldownStorageAvailable && drawCooldownStatus(window.localStorage, drawCooldownScope({
      source,
      statusId: currentStatusId,
      statusUrl: currentStatusUrl || statusUrl,
    })).persistent;

  async function apiFetch(path, options = {}, baseOverride = apiBase) {
    const requestBase = baseOverride;
    if (!requestBase && isStaticHostedPage()) {
      throw new Error('当前是静态前端，请先在设置里确认后端接口地址。');
    }
    if (requestBase && !isTrustedApiBase(requestBase)) {
      throw new Error('后端接口地址不在可信列表里，请使用当前公开后端或本地地址。');
    }
    const headers = new Headers(options.headers || {});
    if (apiKey.trim()) headers.set('x-api-key', apiKey.trim());
    const controller = new AbortController();
    let timedOut = false;
    const relayAbort = () => controller.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) relayAbort();
      else options.signal.addEventListener('abort', relayAbort, { once: true });
    }
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, API_FETCH_TIMEOUT_MS);
    const requestPath = requestBase
      ? `${requestBase}${path.startsWith('/') ? path : `/${path}`}`
      : path;
    const cleanup = () => {
      window.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', relayAbort);
    };
    try {
      const response = await fetch(requestPath, { ...options, headers, signal: controller.signal });
      apiResponseLifecycles.set(response, {
        signal: controller.signal,
        timedOut: () => timedOut,
        cleanup,
      });
      return response;
    } catch (error) {
      cleanup();
      if (timedOut) throw new Error('服务响应超时，请稍后重试。');
      throw error;
    }
  }
  function showStatus(message, tone = 'neutral', options = {}) {
    setStatus(message);
    setStatusTone(tone);
    if (tone === 'error' || options.popup) {
      setNotice({
        id: Date.now(),
        tone,
        title: options.title || (tone === 'error' ? '操作失败' : '提示'),
        message,
      });
    }
  }
  function dismissNotice() {
    setNotice(null);
  }
  function selectReceipt(receipt) {
    if (receipt) setPendingReceipt(null);
    setSelectedReceipt(receipt);
  }
  function refuseWhileBusy() {
    const drawBusy = isDrawing || drawStartRef.current;
    const candidateBusy = isLoading || candidateLoadStartRef.current;
    if (!drawBusy && !candidateBusy) return false;
    showStatus(drawBusy ? '开奖正在进行，请等待结果完成。' : '候选正在载入，请等待载入完成。');
    return true;
  }
  function openSettings(target = 'overview') {
    if (refuseWhileBusy()) return;
    setApiBaseInput(apiBase);
    setSettingsTarget(target);
    setShowSettings(true);
  }
  function openLegalDocument(key) {
    setShowSettings(false);
    setShowSourceEditor(false);
    setLegalDocument(LEGAL_DOCUMENTS[key] || null);
  }
  function openFeedback(category = 'suggestion') {
    setLegalDocument(null);
    setFeedbackInitialCategory(category);
    setShowFeedback(true);
  }
  async function submitFeedback(payload) {
    try {
      const response = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(normalizeFeedbackSubmission(payload)),
      });
      const data = await readApiResponse(response, '反馈服务');
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `提交失败：${response.status}`);
      }
      setStatus('反馈已提交。');
      setStatusTone('success');
      return data;
    } catch (error) {
      showStatus(error.message || '反馈暂时未能送达，请稍后再试。', 'error', { title: '提交失败' });
      throw error;
    }
  }
  function changeSource(value) {
    if (refuseWhileBusy()) return false;
    if (value === source) {
      return true;
    }
    invalidateDrawContext();
    setSource(value);
    setCandidates([]);
    setHistoryUids(new Set());
    setSourceMeta(null);
    setLoadedSource('');
    setSourceInputDirty(false);
    setCandidateLoadError('');
    setCurrentStatusId('');
    setCurrentStatusUrl('');
    setDrawCount(null);
    setDrawCountStatus('idle');
    clearResult();
    return true;
  }
  function selectCandidateSource(value) {
    if (!changeSource(value)) return;
    setShowSourceEditor(true);
  }
  function updateStatusInput(value) {
    if (refuseWhileBusy()) return;
    if (value !== statusUrl) invalidateDrawContext();
    setStatusUrl(value);
    setSourceInputDirty(true);
    setCandidateLoadError('');
    setConfirmedSetup(null);
  }
  function updateManualInput(value) {
    if (refuseWhileBusy()) return;
    if (value !== manualInput) invalidateDrawContext();
    setManualInput(value);
    setSourceInputDirty(true);
    setCandidateLoadError('');
    setConfirmedSetup(null);
  }
  function applyFilterDraft(draft) {
    if (refuseWhileBusy()) return false;
    const nextKeyword = String(draft?.keyword ?? '');
    const nextMentionMin = normalizeMentionMin(draft?.mentionMin);
    const nextBlocklist = String(draft?.blocklist ?? '');
    const nextUniqueByUser = draft?.uniqueByUser !== false;
    const nextExcludePrevious = draft?.excludePrevious === true;
    const changed = keyword !== nextKeyword
      || normalizeMentionMin(mentionMin) !== nextMentionMin
      || blocklist !== nextBlocklist
      || uniqueByUser !== nextUniqueByUser
      || excludePrevious !== nextExcludePrevious;

    setKeyword(nextKeyword);
    setMentionMin(nextMentionMin);
    setBlocklist(nextBlocklist);
    setUniqueByUser(nextUniqueByUser);
    setExcludePrevious(nextExcludePrevious);
    if (changed) {
      setConfirmedSetup(null);
      clearResult('筛选规则已更新，请重新开奖。');
    }
    return true;
  }
  function updateApiBaseInput(value) {
    if (refuseWhileBusy()) return;
    setApiBaseInput(value);
  }
  function setOverlay(setter, value) {
    if (value && refuseWhileBusy()) return;
    setter(value);
  }
  function setShowSourceEditorSafe(value) {
    setOverlay(setShowSourceEditor, value);
  }
  function setShowPrizeEditorSafe(value) {
    setOverlay(setShowPrizeEditor, value);
  }
  function setShowDrawConfirmSafe(value) {
    setOverlay(setShowDrawConfirm, value);
  }
  function setShowFiltersSafe(value) {
    setOverlay(setShowFilters, value);
  }
  function setShowSettingsSafe(value) {
    setOverlay(setShowSettings, value);
  }
  function setShowGuideSafe(value) {
    setOverlay(setShowGuide, value);
  }
  function setShowFeedbackSafe(value) {
    setOverlay(setShowFeedback, value);
  }
  function setLegalDocumentSafe(value) {
    if (value && refuseWhileBusy()) return;
    setLegalDocument(value);
  }
  function setActiveTabSafe(value) {
    if (refuseWhileBusy()) return;
    setActiveTab(value);
  }
  function setMobileCookieSafe(value) {
    if (refuseWhileBusy()) return;
    setMobileCookie(value);
  }
  function setAccessTokenSafe(value) {
    if (refuseWhileBusy()) return;
    setAccessToken(value);
  }
  function setApiKeySafe(value) {
    if (refuseWhileBusy()) return;
    setApiKey(value);
  }
  function setApiBaseSafe(value) {
    if (refuseWhileBusy()) return;
    const cleaned = cleanApiBase(value);
    if (cleaned !== apiBase) apiHealthRequestRef.current += 1;
    setApiBaseInput(cleaned);
    setApiBase(cleaned);
  }
  function commitApiBase(value = apiBaseInput) {
    const raw = String(value || '').trim();
    if (!raw) {
      if (apiBase) apiHealthRequestRef.current += 1;
      setApiBaseInput('');
      setApiBase('');
      return '';
    }
    const cleaned = cleanApiBase(raw);
    if (!isTrustedApiBase(cleaned)) {
      showStatus('后端接口地址不在可信列表里，请使用当前公开后端或本地地址。', 'error', { title: '地址不可用' });
      return null;
    }
    if (cleaned !== apiBase) apiHealthRequestRef.current += 1;
    setApiBaseInput(cleaned);
    setApiBase(cleaned);
    return cleaned;
  }
  function shouldForceCandidateRefresh(value, sourceValue = source) {
    const target = String(value || '').trim();
    const loadedUrl = String(sourceMeta?.statusUrl || '').trim();
    const loadedId = String(sourceMeta?.statusId || '').trim();
    return Boolean(
      candidates.length
      && loadedSource === sourceValue
      && !sourceInputDirty
      && (target === loadedUrl || target === loadedId || (loadedId && target.includes(loadedId))),
    );
  }

  function prepareCandidateLoad(sourceValue, statusValue) {
    const nextSource = sourceValue || source;
    const nextStatusUrl = String(statusValue || '').trim();
    const sameLoadedContext = source === nextSource
      && loadedSource === nextSource
      && !sourceInputDirty
      && (nextSource === 'manual' || nextStatusUrl === statusUrl.trim());

    invalidateDrawContext();
    setSource(nextSource);
    setConfirmedSetup(null);
    setCandidateLoadError('');
    if (nextSource !== 'manual') {
      setStatusUrl(nextStatusUrl);
      setSourceInputDirty(true);
    }

    if (!sameLoadedContext) {
      setCandidates([]);
      setHistoryUids(new Set());
      setSourceMeta(null);
      setLoadedSource('');
      setCurrentStatusId('');
      setCurrentStatusUrl('');
      setDrawCount(null);
      setDrawCountStatus('idle');
    }
    clearResult();
  }

  function showInvalidStatusReference() {
    focusStatusInput();
    showStatus('请粘贴微博正文链接、mid 或 bid。', 'neutral', {
      popup: true,
      title: '微博链接格式不正确',
    });
  }

  function showClipboardReadError(error) {
    focusStatusInput();
    const emptyClipboard = error?.message === 'clipboard-empty';
    showStatus(
      emptyClipboard
        ? '剪贴板中没有内容，请先复制微博正文链接、mid 或 bid。'
        : '无法读取剪贴板，请在输入框中手动粘贴微博正文链接、mid 或 bid。',
      'neutral',
      { popup: true, title: emptyClipboard ? '剪贴板为空' : '无法读取剪贴板' },
    );
  }

  function safeLoadCandidates(options) {
    loadCandidates(options).catch(() => {});
  }
  async function pasteAndLoadCandidates() {
    if (isLoading || isDrawing || candidateLoadStartRef.current || drawStartRef.current) return;
    const existingValue = statusUrl.trim();
    if (existingValue) {
      if (!looksLikeWeiboStatusReference(existingValue)) {
        showInvalidStatusReference();
        return;
      }
      const forceRefresh = shouldForceCandidateRefresh(existingValue, 'mobile');
      prepareCandidateLoad('mobile', existingValue);
      safeLoadCandidates({
        jumpAfterLoad: false,
        sourceOverride: 'mobile',
        statusUrlOverride: existingValue,
        forceRefresh,
      });
      return;
    }
    let pastedValue;
    let clipboardRevision;
    try {
      if (!navigator.clipboard?.readText) throw new Error('clipboard-unavailable');
      clipboardRevision = candidateLoadRevisionRef.current;
      pastedValue = (await navigator.clipboard.readText()).trim();
    } catch (error) {
      showClipboardReadError(error);
      return;
    }
    if (!pastedValue) {
      showClipboardReadError(new Error('clipboard-empty'));
      return;
    }
    if (!mountedRef.current || clipboardRevision !== candidateLoadRevisionRef.current) return;
    if (candidateLoadStartRef.current || drawStartRef.current) {
      showStatus('当前操作正在进行，请稍候再试。');
      return;
    }
    if (!looksLikeWeiboStatusReference(pastedValue)) {
      showInvalidStatusReference();
      return;
    }
    const forceRefresh = shouldForceCandidateRefresh(pastedValue, 'mobile');
    prepareCandidateLoad('mobile', pastedValue);
    safeLoadCandidates({
      jumpAfterLoad: false,
      sourceOverride: 'mobile',
      statusUrlOverride: pastedValue,
      forceRefresh,
    });
  }
  function handleStatusPaste(event) {
    const pastedText = event.clipboardData?.getData('text') || '';
    if (!pastedText || isLoading || isDrawing || candidateLoadStartRef.current || drawStartRef.current) return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const pastedValue = `${input.value.slice(0, start)}${pastedText}${input.value.slice(end)}`.trim();
    if (!looksLikeWeiboStatusReference(pastedValue)) return;
    event.preventDefault();
    const forceRefresh = shouldForceCandidateRefresh(pastedValue, 'mobile');
    prepareCandidateLoad('mobile', pastedValue);
    safeLoadCandidates({
      jumpAfterLoad: false,
      sourceOverride: 'mobile',
      statusUrlOverride: pastedValue,
      forceRefresh,
    });
  }
  function clearResult(message) {
    if (isBusy) return false;
    invalidateDrawContext();
    if (message && results.length) showStatus(message);
    setResults([]);
    setLastAudit(null);
    setSelectedReceipt(null);
    setPendingReceipt(null);
    return true;
  }
  function applySettingsAction(kind) {
    if (refuseWhileBusy()) return;
    if (kind === 'current-draw') {
      setCandidates([]);
      setHistoryUids(new Set());
      setConfirmedSetup(null);
      setSourceMeta(null);
      setLoadedSource('');
      setCandidateLoadError('');
      setSourceInputDirty(Boolean(source === 'manual' ? manualInput.trim() : statusUrl.trim()));
      setCurrentStatusId('');
      setCurrentStatusUrl('');
      clearResult();
      showStatus('已清空当前候选和结果。', 'success', { popup: true, title: '已清空' });
      return;
    }
    if (kind === 'local-history') {
      const stored = writeDrawHistory(window.localStorage, []);
      if (!stored.ok) {
        showStatus('本机存储不可用，未能清空开奖记录。', 'error', { title: '操作未完成' });
        return;
      }
      setDrawHistory([]);
      setHistoryUids(new Set());
      setConfirmedSetup(null);
      showStatus('已清空本机开奖记录。', 'success', { popup: true, title: '已清空' });
    }
  }
  function jumpToPrizeSettings() {
    setShowPrizeEditor(true);
  }
  function ensurePrizeSettingsReady() {
    if (!normalizedPrizes.length || totalSlots < 1) {
      showStatus('请先填写至少一个奖项名称和中奖人数。', 'error');
      jumpToPrizeSettings();
      return false;
    }
    return true;
  }
  function confirmDrawSetup() {
    if (refuseWhileBusy()) return false;
    if (!ensurePrizeSettingsReady()) return false;
    if (prizes.length > MAX_DRAW_RESULT_GROUPS) {
      showStatus(`单次最多设置 ${MAX_DRAW_RESULT_GROUPS} 个奖项。`, 'error');
      return false;
    }
    if (!candidateSourceReady) {
      setShowSourceEditor(true);
      showStatus('来源或链接已更改，请先重新载入候选。', 'error');
      return false;
    }
    if (!eligible.length) {
      showStatus('当前没有可抽候选，请先载入名单或调整筛选规则。', 'error');
      return false;
    }
    if (totalSlots > eligible.length) {
      showStatus(`中奖总人数 ${totalSlots} 不能超过可抽人数 ${eligible.length}。`, 'error');
      return false;
    }
    if (totalSlots > MAX_DRAW_WINNERS) {
      showStatus(`单次开奖最多设置 ${MAX_DRAW_WINNERS} 个中奖名额。`, 'error');
      return false;
    }
    setConfirmedSetup({
      candidates,
      prizes,
      source,
      statusId: currentStatusId,
      statusUrl: currentStatusUrl,
      keyword,
      mentionMin: rules.mentionMin,
      blocklist,
      uniqueByUser,
      excludePrevious,
      eligibleCount: eligible.length,
    });
    showStatus('抽奖设置已确认，请核对本轮信息后开奖。', 'success');
    return true;
  }
  function requestDraw() {
    if (refuseWhileBusy()) return;
    if (source === 'manual' && manualDrawLimitReached) {
      showStatus('手动名单开奖次数已达到浏览器可记录的上限，请先导出并清理本机记录。', 'error');
      return;
    }
    if (pendingReceipt) {
      showStatus('本次结果正在准备，请稍候。', 'neutral', { popup: true, title: '请稍候' });
      return;
    }
    if (candidates.length && !candidateSourceReady) {
      setShowSourceEditor(true);
      showStatus('来源或链接已更改，请先重新载入候选。');
      return;
    }
    if (!eligible.length) {
      setShowFilters(true);
      return;
    }
    if (!drawSetupConfirmed) {
      setShowPrizeEditor(true);
      return;
    }
    setShowDrawConfirm(true);
  }
  function confirmAndDraw(options = {}) {
    if (refuseWhileBusy()) return;
    if (!drawSetupConfirmed) {
      setShowDrawConfirm(false);
      setShowPrizeEditor(true);
      showStatus('抽奖设置已变化，请重新确认。', 'error');
      return;
    }
    if (!options.practice) {
      const scope = drawCooldownScope({
        source,
        statusId: currentStatusId,
        statusUrl: currentStatusUrl || statusUrl,
      });
      const cooldown = drawCooldownStatus(window.localStorage, scope);
      if (cooldown.blocked) {
        const message = cooldown.reason === 'running'
          ? '本链接正在当前浏览器的另一个页面开奖，请稍后再试。'
          : `本链接刚刚完成开奖，请 ${Math.max(1, Math.ceil(cooldown.remainingMs / 1000))} 秒后再试。`;
        showStatus(message, 'error', { title: '请稍后开奖' });
        return;
      }
    }
    const startDraw = () => drawAll({ practice: Boolean(options.practice) });
    if (typeof options.close === 'function') {
      options.close(startDraw);
    } else {
      setShowDrawConfirm(false);
      startDraw();
    }
  }
  function updatePrize(index, patch) {
    if (refuseWhileBusy()) return;
    const current = prizes[index];
    if (!current) return;
    const changed = Object.entries(patch).some(([key, value]) => !Object.is(current[key], value));
    if (!changed) return;
    setPrizes((previous) => previous.map((prize, prizeIndex) => (
      prizeIndex === index ? { ...prize, ...patch } : prize
    )));
    clearResult('奖项已更新，请重新开奖。');
  }
  function updatePrizeCount(index, nextCount) {
    if (String(nextCount) === '') {
      updatePrize(index, { count: '' });
      return;
    }
    const count = Math.floor(Number(nextCount));
    if (!Number.isFinite(count)) return;
    updatePrize(index, { count: Math.min(MAX_DRAW_WINNERS, Math.max(1, count)) });
  }
  function commitPrizeCount(index) {
    const count = Math.floor(Number(prizes[index]?.count));
    if (Number.isFinite(count) && count >= 1) return;
    updatePrize(index, { count: 1 });
  }
  function addPrize() {
    if (refuseWhileBusy()) return;
    if (prizes.length >= MAX_DRAW_RESULT_GROUPS) {
      showStatus(`单次最多设置 ${MAX_DRAW_RESULT_GROUPS} 个奖项。`, 'error');
      return;
    }
    setPrizes((previous) => [...previous, defaultPrize(previous.length, 1)]);
    clearResult('奖项已更新，请重新开奖。');
  }
  function removePrize(index) {
    if (refuseWhileBusy()) return;
    if (prizes.length <= 1) {
      showStatus('至少保留一个奖项。', 'error');
      return;
    }
    setPrizes((previous) => previous.filter((_, prizeIndex) => prizeIndex !== index));
    clearResult('奖项已更新，请重新开奖。');
  }

  async function loadCookieStatus(check = false) {
    const requestId = ++cookieStatusRequestRef.current;
    const requestBase = apiBase;
    setCookieHealth('checking');
    try {
      const response = await apiFetch(
        `/api/weibo/cookie-status${check ? '?check=1' : ''}`,
        {},
        requestBase,
      );
      const json = await readApiResponse(response, 'Cookie 状态服务');
      if (!json.ok) throw new Error(json.error || '服务器 Cookie 状态读取失败');
      if (requestId !== cookieStatusRequestRef.current) return;
      setCookieInfo(json);
      setCookieHealth('ok');
      if (check) {
        const verifiedCount = Number(json.verifiedAccountCount || 0);
        if (json.checkSkipped) {
          showStatus('服务器 Cookie 校验受站长密钥保护，普通访客只能查看保存状态。');
        } else {
          showStatus(verifiedCount > 0
            ? `${verifiedCount} 个服务器登录态通过最近校验，失效项已自动移除。`
            : json.hasCookie
              ? '服务器已保存登录态，但目前没有通过最近校验的账号。'
              : '暂无服务器登录态，可以展开并填写备用 Cookie。');
        }
      }
    } catch (error) {
      if (requestId !== cookieStatusRequestRef.current) return;
      setCookieHealth('error');
      if (check) showStatus(error.message, 'error');
    }
  }

  async function refreshApiHealth() {
    const requestId = ++apiHealthRequestRef.current;
    const requestBase = apiBase;
    setApiHealth('checking');
    try {
      const response = await apiFetch('/api/health', {}, requestBase);
      const json = await readApiResponse(response, '后端服务');
      if (!json.ok) throw new Error(json.error || '后端没有返回 ok');
      if (requestId === apiHealthRequestRef.current) setApiHealth('ok');
    } catch {
      if (requestId === apiHealthRequestRef.current) setApiHealth('error');
    }
  }

  async function testApiConnection() {
    const targetBase = commitApiBase();
    if (targetBase === null) return;
    const requestId = ++apiHealthRequestRef.current;
    cookieStatusRequestRef.current += 1;
    setApiHealth('checking');
    try {
      const response = await apiFetch('/api/health', {}, targetBase);
      const json = await readApiResponse(response, '后端服务');
      if (!json.ok) throw new Error(json.error || '后端没有返回 ok');
      if (requestId !== apiHealthRequestRef.current) return;
      setApiHealth('ok');
      showStatus(`后端连接成功：${targetBase || location.origin}`, 'success', { popup: true, title: '连接正常' });
    } catch (error) {
      if (requestId !== apiHealthRequestRef.current) return;
      setApiHealth('error');
      showStatus(`后端连接失败：${error.message}`, 'error');
    }
  }

  async function refreshDrawCount(value = statusUrl) {
    const requestId = ++drawCountRequestRef.current;
    if (source === 'manual' || !value.trim()) {
      setDrawCount(null);
      setDrawCountStatus('idle');
      return;
    }
    setDrawCountStatus('loading');
    try {
      const response = await apiFetch(`/api/weibo/draw-count?statusUrl=${encodeURIComponent(value)}`);
      const json = await readApiResponse(response, '开奖记录服务');
      if (!json.ok) throw new Error(json.error || '抽奖次数查询失败');
      if (requestId !== drawCountRequestRef.current) return;
      const nextCount = Number(json.drawCount);
      if (Number.isFinite(nextCount) && nextCount >= 0) {
        setDrawCount(Math.floor(nextCount));
        setDrawCountStatus('ready');
      } else {
        setDrawCount(null);
        setDrawCountStatus('unknown');
      }
    } catch {
      if (requestId !== drawCountRequestRef.current) return;
      setDrawCount(null);
      setDrawCountStatus('error');
    }
  }

  useEffect(() => {
    refreshApiHealth().catch(() => {});
    loadCookieStatus(false).catch(() => {});
  }, [apiBase]);
  useEffect(() => {
    const cleaned = cleanApiBase(apiBase);
    writeStoredValue('weibo-draw-api-base', cleaned && isTrustedApiBase(cleaned) ? cleaned : '');
  }, [apiBase]);
  useEffect(() => {
    writeStoredValue('weibo-draw-motion', motionPreference);
  }, [motionPreference]);
  useEffect(() => {
    const result = writeDrawHistory(window.localStorage, drawHistory);
    setHistoryStorageAvailable(result.ok);
    if (!result.ok) {
      showStatus('本机存储空间不足，当前页面仍可查看结果，但刷新后可能无法保留全部记录。', 'error', { title: '本机记录未完整保存' });
      return;
    }
    if (result.items.length < drawHistory.length) {
      setDrawHistory(result.items);
      setHistoryUids(winnerIdsForStatus(result.items, currentStatusId));
      const noticeKey = `${drawHistory.length}:${result.items.length}`;
      if (historyStorageNoticeRef.current !== noticeKey) {
        historyStorageNoticeRef.current = noticeKey;
        showStatus(`本机空间有限，已保留最近 ${result.items.length} 条开奖记录。`, 'neutral', { popup: true, title: '记录已整理' });
      }
    }
  }, [drawHistory]);
  useEffect(() => {
    if (source === 'manual' || !looksLikeWeiboStatusReference(statusUrl)) {
      drawCountRequestRef.current += 1;
      setDrawCount(null);
      setDrawCountStatus('idle');
      return undefined;
    }
    const timer = setTimeout(() => refreshDrawCount(statusUrl), 700);
    return () => clearTimeout(timer);
  }, [statusUrl, source, apiBase]);
  useEffect(() => {
    if (!pendingReceipt || isDrawing || selectedReceipt) return undefined;
    const reducedMotion = shouldReduceMotion(motionPreference);
    const receipt = pendingReceipt;
    const timer = window.setTimeout(() => {
      if (selectedReceiptRef.current) return;
      setSelectedReceipt(receipt);
      setPendingReceipt((current) => current?.id === receipt.id ? null : current);
    }, reducedMotion ? 220 : 680);
    return () => window.clearTimeout(timer);
  }, [pendingReceipt, isDrawing, motionPreference, selectedReceipt]);

  async function fetchRepostsWithProgress(payload, operation) {
    setProgress({ percent: 3, message: '创建抓取任务' });
    const startResponse = await apiFetch('/api/weibo/reposts/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const started = await readApiResponse(startResponse, '候选载入服务');
    if (!started.ok) throw new Error(started.error || '抓取任务创建失败');
    operation.jobId = started.jobId || '';
    operation.readToken = started.readToken || '';
    operation.cancelToken = started.cancelToken || '';
    if (operation.jobId && operation.cancelToken) {
      operation.cancelServer = () => {
        if (operation.cancelRequested) return Promise.resolve();
        operation.cancelRequested = true;
        return apiFetch(`/api/weibo/reposts/jobs/${encodeURIComponent(operation.jobId)}`, {
          method: 'DELETE',
          headers: { 'x-job-cancel-token': operation.cancelToken },
          keepalive: true,
        }).then((response) => readApiResponse(response, '候选取消服务')).catch(() => {});
      };
    }
    if (operation.cancelIntent) {
      await operation.cancelServer?.();
      operation.controller.abort();
      throw new DOMException('候选载入已取消', 'AbortError');
    }
    let lastProgress = started.progress || { percent: 3, message: '任务已创建' };
    if (started.delivery === 'shared-running') {
      lastProgress = { ...lastProgress, message: `已合并到同一微博的载入任务 · ${lastProgress.message}` };
    } else if (started.delivery === 'recent-snapshot') {
      lastProgress = { ...lastProgress, message: '正在读取刚刚载入的候选快照' };
    }
    const deadline = Date.now() + REPOST_JOB_TIMEOUT_MS;
    let reconnectAttempts = 0;
    setProgress(lastProgress);
    if (started.status === 'done' && started.result) {
      return {
        ...started.result,
        meta: { ...(started.result.meta || {}), delivery: started.delivery || 'fresh' },
      };
    }
    while (true) {
      if (operation.controller.signal.aborted) throw new DOMException('候选载入已取消', 'AbortError');
      if (Date.now() > deadline) {
        operation.cancelServer?.();
        throw new Error('抓取任务等待时间过长，服务器已停止本次任务。');
      }
      await sleep(REPOST_JOB_POLL_MS, operation.controller.signal);
      let response;
      let json;
      try {
        response = await apiFetch(`/api/weibo/reposts/jobs/${encodeURIComponent(started.jobId)}`, {
          headers: { 'x-job-read-token': operation.readToken },
          signal: operation.controller.signal,
        });
        json = await readApiResponse(response, '候选载入服务');
        if (!json.ok) {
          const error = new Error(json.error || '抓取进度读取失败');
          error.status = response.status;
          throw error;
        }
        reconnectAttempts = 0;
      } catch (error) {
        if (operation.controller.signal.aborted || error?.name === 'AbortError') throw error;
        const statusCode = Number(error?.status || response?.status || 0);
        const retryable = !statusCode || statusCode === 429 || statusCode >= 500;
        if (!retryable || reconnectAttempts >= REPOST_JOB_RECONNECT_ATTEMPTS) throw error;
        reconnectAttempts += 1;
        setProgress({
          ...lastProgress,
          message: `连接暂时中断，正在重新读取任务（${reconnectAttempts}/${REPOST_JOB_RECONNECT_ATTEMPTS}）`,
        });
        await sleep(REPOST_JOB_RECONNECT_BASE_MS * reconnectAttempts, operation.controller.signal);
        continue;
      }
      lastProgress = json.progress || lastProgress;
      setProgress(lastProgress);
      if (json.status === 'done') {
        return {
          ...json.result,
          meta: { ...(json.result?.meta || {}), delivery: started.delivery || json.delivery || 'fresh' },
        };
      }
      if (json.status === 'cancelled') throw new DOMException('候选载入已取消', 'AbortError');
      if (json.status === 'error') throw new Error(json.error || lastProgress.message || '抓取失败');
    }
  }

  function cancelCandidateLoad() {
    const operation = repostLoadRef.current;
    if (!operation || operation.cancelIntent || operation.controller.signal.aborted) return;
    candidateLoadRevisionRef.current += 1;
    operation.cancelIntent = true;
    if (operation.cancelServer) {
      operation.cancelServer();
      operation.controller.abort();
    }
    setCandidateLoadError('候选载入已取消，请重新载入后再开奖。');
    setProgress((current) => ({
      percent: current?.percent || 0,
      message: '正在取消候选载入',
    }));
    showStatus('候选载入已取消，请重新载入后再开奖。');
  }

  async function loadCandidates(options = {}) {
    if (candidateLoadStartRef.current) {
      showStatus('候选正在载入，请稍候或先取消当前任务。');
      return null;
    }
    if (isDrawing || drawStartRef.current) {
      refuseWhileBusy();
      return null;
    }
    const {
      jumpAfterLoad = true,
      sourceOverride = source,
      statusUrlOverride = statusUrl,
      forceRefresh = false,
    } = options;
    const activeOperation = repostLoadRef.current;
    if (activeOperation && !activeOperation.controller.signal.aborted) {
      showStatus('候选正在载入，请稍候或先取消当前任务。');
      return null;
    }
    candidateLoadStartRef.current = true;
    setConfirmedSetup(null);
    setCandidateLoadError('');
    const effectiveSource = sourceOverride;
    const effectiveStatusUrl = String(statusUrlOverride || '').trim();
    window.clearTimeout(progressClearTimerRef.current);
    setProgress(null);
    const operation = effectiveSource === 'manual'
      ? null
      : {
        controller: new AbortController(),
        jobId: '',
        readToken: '',
        cancelToken: '',
        cancelServer: null,
        cancelRequested: false,
        cancelIntent: false,
      };
    if (operation) repostLoadRef.current = operation;
    setIsLoading(true);
    clearResult();
    const loadRevision = ++candidateLoadRevisionRef.current;
    try {
      if (effectiveSource === 'manual') {
        const parsed = parseManualInput(manualInput);
        if (!parsed.length) throw new Error('请先粘贴或导入候选名单。');
        const freshHistory = new Set();
        const manualMeta = { provider: 'manual', loadedAt: new Date().toISOString() };
        setCandidates(parsed);
        setCurrentStatusId('');
        setCurrentStatusUrl('');
        setDrawCount(null);
        setDrawCountStatus('idle');
        setSourceMeta(manualMeta);
        setLoadedSource('manual');
        setSourceInputDirty(false);
        setCandidateLoadError('');
        setHistoryUids(freshHistory);
        showStatus(`已导入 ${parsed.length} 位候选用户，请确认奖项设置。`, 'success');
        if (jumpAfterLoad) jumpToPrizeSettings();
        return {
          candidates: parsed,
          eligible: eligibleCandidates(parsed, rules, freshHistory),
          statusId: '',
          statusUrl: '',
          sourceMeta: manualMeta,
        };
      }
      if (!effectiveStatusUrl) throw new Error('请先粘贴微博正文链接、mid 或 bid。');
      if (effectiveSource === 'official' && !accessToken.trim()) throw new Error('请先填写微博官方访问令牌。');
      setStatusUrl(effectiveStatusUrl);
      showStatus(effectiveSource === 'mobile'
        ? '正在通过服务器登录态读取微博转发；不可用时再尝试备用 Cookie。'
        : '正在通过微博官方接口读取当前接口可见的转发。');
      const json = await fetchRepostsWithProgress({
        source: effectiveSource,
        statusUrl: effectiveStatusUrl,
        accessToken,
        mobileCookie: effectiveSource === 'mobile' ? mobileCookie : '',
        forceRefresh,
      }, operation);
      if (!isCurrentCandidateLoad(loadRevision, operation)) return null;
      if (!json.ok) throw new Error(json.error || '微博数据拉取失败');
      const loadedCandidates = json.candidates || [];
      const loadedStatusId = json.statusId || '';
      const freshHistory = winnerIdsForStatus(drawHistory, loadedStatusId);
      setCandidates(loadedCandidates);
      setCurrentStatusId(loadedStatusId);
      setCurrentStatusUrl(json.statusUrl || effectiveStatusUrl);
      const loadedDrawCount = Number(json.drawCount);
      if (Number.isFinite(loadedDrawCount) && loadedDrawCount >= 0) {
        setDrawCount(Math.floor(loadedDrawCount));
        setDrawCountStatus('ready');
      } else {
        setDrawCount(null);
        setDrawCountStatus('unknown');
      }
      setSourceMeta({ ...(json.meta || {}), statusId: json.statusId, statusUrl: json.statusUrl });
      setLoadedSource(effectiveSource);
      setSourceInputDirty(false);
      setCandidateLoadError('');
      setHistoryUids(freshHistory);
      if (effectiveSource === 'mobile' && mountedRef.current) loadCookieStatus(false).catch(() => {});
      const pageCount = Array.isArray(json.meta?.pages) ? json.meta.pages.length : 0;
      const totalNumber = Number(json.meta?.totalNumber);
      const totalText = Number.isFinite(totalNumber) ? `接口显示总转发约 ${totalNumber} 条。` : '';
      const deliveryText = json.meta?.delivery === 'recent-snapshot'
        ? '已复用刚刚完成的候选快照。'
        : json.meta?.delivery === 'shared-running'
          ? '本次与同一微博的载入任务合并完成。'
          : '';
      const headText = Number(json.meta?.headAddedCount || 0) > 0
        ? `完成前补入 ${Number(json.meta.headAddedCount)} 条新转发。`
        : json.meta?.headReconciled
          ? '完成前已复核最新转发。'
          : '';
      showStatus(`已载入 ${json.candidates?.length || 0} 条可见转发，扫描 ${pageCount} 页。${totalText ? `${totalText} ` : ''}${deliveryText}${headText}请确认奖项后开奖。`, 'success');
      if (jumpAfterLoad) jumpToPrizeSettings();
      return {
        candidates: loadedCandidates,
        eligible: eligibleCandidates(loadedCandidates, rules, freshHistory),
        statusId: json.statusId || '',
        statusUrl: json.statusUrl || effectiveStatusUrl,
        sourceMeta: { ...(json.meta || {}), statusId: json.statusId, statusUrl: json.statusUrl },
      };
    } catch (error) {
      if (!isCurrentCandidateLoad(loadRevision, operation)) return null;
      operation?.cancelServer?.();
      if (operation?.controller.signal.aborted || error?.name === 'AbortError') {
        const message = '候选载入已取消，请重新载入后再开奖。';
        setCandidateLoadError(message);
        showStatus(message);
        return null;
      }
      const message = error?.message || '微博数据拉取失败。';
      setCandidateLoadError(message);
      showStatus(message, 'error');
      throw error;
    } finally {
      const ownsLoad = !operation || repostLoadRef.current === operation;
      if (ownsLoad) {
        candidateLoadStartRef.current = false;
      }
      if (mountedRef.current && effectiveSource === 'mobile') setMobileCookie('');
      if (mountedRef.current && effectiveSource === 'official') setAccessToken('');
      if (ownsLoad) {
        repostLoadRef.current = null;
        if (mountedRef.current) {
          setIsLoading(false);
          progressClearTimerRef.current = window.setTimeout(() => {
            if (mountedRef.current) setProgress(null);
          }, 1200);
        }
      }
    }
  }

  function cancelDraw() {
    const operation = drawOperationRef.current;
    if (!isDrawing || !operation || operation.signal.aborted) return;
    setPhase('正在停止开奖');
    operation.abort();
  }

  async function drawAll({ practice = false } = {}) {
    if (drawStartRef.current || drawOperationRef.current || isDrawing || isLoading || pendingReceipt) return;
    if (!ensurePrizeSettingsReady()) return;
    if (!drawSetupConfirmed) {
      setShowPrizeEditor(true);
      showStatus('请先确认本轮奖项设置。');
      return;
    }
    const drawCandidates = candidates;
    const drawEligible = eligible;
    const drawContext = { statusId: currentStatusId, statusUrl: currentStatusUrl, sourceMeta };
    const taskRevision = taskRevisionRef.current;
    if (totalSlots > drawEligible.length) {
      showStatus(`中奖总人数 ${totalSlots} 不能超过可抽人数 ${drawEligible.length}。`, 'error');
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    drawOperationRef.current = controller;
    drawStartRef.current = true;
    let tabLock = null;
    let guard = null;
    let drawCompleted = false;
    try {
      const scope = drawCooldownScope({
        source,
        statusId: drawContext.statusId,
        statusUrl: drawContext.statusUrl || statusUrl,
      });
      tabLock = await acquireDrawTabLock(scope);
      throwIfAborted(signal);
      if (!tabLock.ok) {
        showStatus('本链接正在当前浏览器的另一个页面开奖，请稍后再试。', 'error', { title: '请稍后开奖' });
        return;
      }
      drawTabLockRef.current = tabLock;
      guard = practice
        ? { ok: true, persistent: false, scope, token: null }
        : acquireDrawGuard(window.localStorage, scope);
      if (!practice && source !== 'manual') setCooldownStorageAvailable(guard.persistent !== false);
      if (!guard.ok) {
        const message = guard.reason === 'running'
          ? '本链接正在当前浏览器的另一个页面开奖，请稍后再试。'
          : `本链接刚刚完成开奖，请 ${Math.max(1, Math.ceil(guard.remainingMs / 1000))} 秒后再试。`;
        showStatus(message, 'error', { title: '请稍后开奖' });
        return;
      }
      drawGuardRef.current = practice ? null : guard;
      setIsDrawing(true);
      setResults([]);
      setRollingCandidate(null);

      const reducedMotion = shouldReduceMotion(motionPreference);
      const seed = randomSeedHex();
      const candidateDigest = await digestCandidates(drawEligible);
      throwIfAborted(signal);
      const pool = await seededShuffle(drawEligible, `${seed}:${candidateDigest}`);
      throwIfAborted(signal);
      const rollingPool = [];
      const rollingSeen = new Set();
      const avatarCandidates = [
        ...pool.slice(0, Math.min(totalSlots, 8)),
        ...pool.filter((candidate) => safeAvatarUrl(candidate.avatar)),
        ...pool,
      ];
      for (const candidate of avatarCandidates) {
        const key = candidateIdentity(candidate);
        if (!key || rollingSeen.has(key)) continue;
        rollingSeen.add(key);
        rollingPool.push(candidate);
        if (rollingPool.length >= 18) break;
      }
      await warmDrawAvatars(rollingPool, apiBase, signal);
      throwIfAborted(signal);
      const all = [];
      let offset = 0;
      for (let prizeIndex = 0; prizeIndex < normalizedPrizes.length; prizeIndex += 1) {
        const prize = normalizedPrizes[prizeIndex];
        const prizeWinners = pool.slice(offset, offset + Number(prize.count || 0));
        offset += Number(prize.count || 0);
        setPhase(`正在抽取 ${prize.name}`);
        showStatus(`正在抽取 ${prize.name}。`);
        const baseDuration = prizeIndex === 0 ? 1700 : 1200;
        const duration = reducedMotion
          ? 80
          : Math.min(2100, baseDuration + Number(prize.count || 1) * 80);
        if (!reducedMotion) {
          const startedAt = Date.now();
          let tick = 0;
          while (Date.now() - startedAt < duration) {
            const index = rollingPool.length
              ? (prizeIndex * 19 + tick * 7 + Math.floor(tick / 3)) % rollingPool.length
              : 0;
            setRollingCandidate(rollingPool[index] || null);
            await sleep(88, signal);
            tick += 1;
          }
        }
        setRollingCandidate(prizeWinners.at(-1) || null);
        setPhase(`${prize.name} 开奖完成`);
        if (!reducedMotion) await sleep(360, signal);
        all.push({ prize, winners: prizeWinners });
        setResults([...all]);
        if (prizeIndex < normalizedPrizes.length - 1 && !reducedMotion) await sleep(260, signal);
      }
      throwIfAborted(signal);
      const audit = {
        practice,
        seed,
        drawnAt: new Date().toISOString(),
        statusId: drawContext.statusId || currentStatusId,
        statusUrl: drawContext.statusUrl || currentStatusUrl,
        rules: {
          filters: {
            keyword,
            mentionMin: rules.mentionMin,
            uniqueByUser,
            excludePrevious,
            blocklistCount: rules.blocked.size,
          },
          prizes: normalizedPrizes,
        },
        candidateDigest,
        eligibleCount: drawEligible.length,
      };
      setLastAudit(audit);
      const activeSourceMeta = {
        ...(drawContext.sourceMeta || sourceMeta || {}),
        statusId: drawContext.statusId || currentStatusId,
        statusUrl: drawContext.statusUrl || currentStatusUrl || statusUrl.trim(),
      };
      const receipt = normalizeDrawReceipt({
        id: `local-${audit.drawnAt}`,
        source,
        statusId: audit.statusId,
        statusUrl: audit.statusUrl,
        drawNumber: null,
        drawnAt: audit.drawnAt,
        savedAt: '',
        results: all,
        candidateCount: drawCandidates.length,
        eligibleCount: drawEligible.length,
        rules: audit.rules,
        sourceMeta: activeSourceMeta,
        seed: audit.seed,
        candidateDigest: audit.candidateDigest,
        auditHash: '',
        recordState: practice ? 'practice' : 'local',
      });
      if (!practice) {
        const wonIds = new Set(historyUids);
        all.flatMap((item) => item.winners).forEach((winner) => {
          const identity = String(winner.uid || winner.screenName || winner.id || '').toLowerCase();
          if (identity) wonIds.add(identity);
        });
        setHistoryUids(wonIds);
        setDrawHistory((previous) => upsertDrawReceipt(previous, receipt));
      }
      setPendingReceipt(receipt);
      setConfirmedSetup(null);
      drawCompleted = true;
      if (practice) {
        setPhase('本地演练完成');
        showStatus('本地演练完成，未保存开奖记录。', 'success');
      } else {
        completeDrawGuard(window.localStorage, guard.scope, guard.token);
        setPhase('正在同步开奖记录');
        showStatus(`已抽出 ${receipt.total} 位中奖用户，正在同步开奖记录。`, 'success');
        const syncController = new AbortController();
        drawSyncControllersRef.current.add(syncController);
        void syncDrawReceipt(receipt, {
          results: all,
          source,
          statusId: drawContext.statusId || currentStatusId,
          statusUrl: drawContext.statusUrl || currentStatusUrl || statusUrl.trim(),
          sourceMeta: activeSourceMeta,
          totalCount: drawCandidates.length,
          eligibleCount: drawEligible.length,
          audit,
          signal: syncController.signal,
          taskRevision,
        }).finally(() => {
          drawSyncControllersRef.current.delete(syncController);
        });
      }
    } catch (error) {
      setResults([]);
      setRollingCandidate(null);
      setLastAudit(null);
      setPendingReceipt(null);
      if (error?.name === 'AbortError') {
        showStatus('本次开奖已停止，未产生有效结果。');
      } else {
        showStatus(error.message, 'error');
      }
    } finally {
      drawStartRef.current = false;
      if (!practice && guard?.ok && !drawCompleted) {
        releaseDrawGuard(window.localStorage, guard.scope, guard.token);
      }
      if (drawGuardRef.current === guard) drawGuardRef.current = null;
      if (tabLock?.release) await Promise.resolve(tabLock.release()).catch(() => {});
      if (drawTabLockRef.current === tabLock) drawTabLockRef.current = null;
      if (drawOperationRef.current === controller) drawOperationRef.current = null;
      setPhase('');
      setIsDrawing(false);
    }
  }

  async function saveResult(options = {}) {
    const opts = options?.nativeEvent ? {} : options;
    const activeResults = Array.isArray(opts.results) ? opts.results : results;
    const activeWinners = activeResults.flatMap((item) => item.winners || []);
    if (!activeWinners.length) return null;
    try {
      const activeSourceMeta = opts.sourceMeta || sourceMeta || {};
      const activeStatusId = opts.statusId ?? currentStatusId;
      const activeStatusUrl = opts.statusUrl ?? currentStatusUrl;
      const payload = {
        source: opts.source ?? source,
        statusId: activeStatusId,
        statusUrl: activeStatusUrl,
        sourceMeta: {
          ...activeSourceMeta,
          statusId: activeStatusId || activeSourceMeta?.statusId,
          statusUrl: activeStatusUrl || activeSourceMeta?.statusUrl,
        },
        results: activeResults.map((item) => ({
          prize: item.prize,
          winners: (item.winners || []).map((winner) => ({
            id: winner.id,
            uid: winner.uid,
            screenName: winner.screenName,
            avatar: winner.avatar,
          })),
        })),
        totalCount: opts.totalCount ?? candidates.length,
        eligibleCount: opts.eligibleCount ?? lastAudit?.eligibleCount ?? eligible.length,
        audit: opts.audit ?? lastAudit,
      };
      const response = await apiFetch('/api/draws', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: opts.signal,
      });
      const json = await readApiResponse(response, '开奖记录服务');
      if (!json.ok) throw new Error(json.error || '保存失败');
      if (opts.updateCurrentTask !== false) {
        if (json.statusId) setCurrentStatusId(json.statusId);
        if (json.statusUrl) setCurrentStatusUrl(json.statusUrl);
        if (json.drawCount !== null && json.drawCount !== undefined) {
          setDrawCount(json.drawCount);
          setDrawCountStatus('ready');
        }
      }
      if (!opts.silent) showStatus(`开奖记录已保存：${json.file}`, 'success');
      return json;
    } catch (error) {
      if (!opts.silent) showStatus(error.message, 'error');
      if (opts.throwOnError) throw error;
      return null;
    }
  }

  function setReceiptSyncing(receiptId, syncing) {
    if (!receiptId) return;
    setSyncingReceiptIds((current) => {
      const next = new Set(current);
      if (syncing) next.add(receiptId);
      else next.delete(receiptId);
      return next;
    });
  }

  function manualDrawNumberFromSave(value, history, excludeId = '') {
    const persisted = Number(value);
    if (Number.isSafeInteger(persisted) && persisted > 0) {
      manualDrawSequenceRef.current = Math.max(manualDrawSequenceRef.current, persisted);
      return persisted;
    }

    const historyNext = nextManualDrawNumber(history, excludeId);
    const refNext = manualDrawSequenceRef.current >= Number.MAX_SAFE_INTEGER
      ? null
      : manualDrawSequenceRef.current + 1;
    if (historyNext === null || refNext === null) return null;

    const next = Math.max(historyNext, refNext);
    if (!Number.isSafeInteger(next)) return null;
    manualDrawSequenceRef.current = next;
    return next;
  }

  async function syncDrawReceipt(receipt, saveOptions) {
    const { taskRevision, ...requestOptions } = saveOptions;
    setReceiptSyncing(receipt.id, true);
    try {
      const saved = await saveResult({
        ...requestOptions,
        silent: true,
        throwOnError: true,
        updateCurrentTask: false,
      });
      if (!saved?.file) throw new Error('服务器没有返回开奖记录文件');
      const manualDrawNumber = receipt.source === 'manual'
        ? manualDrawNumberFromSave(saved.drawNumber, drawHistory, receipt.id)
        : null;
      const updated = normalizeDrawReceipt({
        ...receipt,
        id: receipt.id,
        drawNumber: saved.drawNumber ?? manualDrawNumber,
        savedAt: saved.savedAt,
        auditHash: saved.auditHash,
        recordState: 'server',
      });
      setDrawHistory((history) => upsertDrawReceipt(history, updated));
      const isCurrentTask = taskRevisionRef.current === taskRevision;
      if (isCurrentTask) {
        setPendingReceipt((current) => current?.id === receipt.id ? updated : current);
        setSelectedReceipt((current) => current?.id === receipt.id ? updated : current);
        if (saved.statusId) setCurrentStatusId(saved.statusId);
        if (saved.statusUrl) setCurrentStatusUrl(saved.statusUrl);
        if (saved.drawCount !== null && saved.drawCount !== undefined) {
          setDrawCount(saved.drawCount);
          setDrawCountStatus('ready');
        }
        showStatus(`已抽出 ${updated.total} 位中奖用户，开奖记录已同步。`, 'success');
      }
      return updated;
    } catch (error) {
      if (requestOptions.signal?.aborted || error?.name === 'AbortError') return null;
      const message = historyStorageAvailable
        ? '服务器同步失败，结果已保留在当前浏览器。重新保存成功后才会计入服务器开奖次数。'
        : '服务器同步失败且本机存储不可用。关闭页面前请保存结果图或导出名单。';
      if (taskRevisionRef.current === taskRevision) {
        setPendingReceipt((current) => current?.id === receipt.id ? null : current);
        const viewedReceipt = selectedReceiptRef.current;
        const canPresentFailure = !viewedReceipt || viewedReceipt.id === receipt.id;
        if (canPresentFailure) {
          setSelectedReceipt((current) => {
            if (current && current.id !== receipt.id) return current;
            return current || receipt;
          });
          showStatus(`${message} ${error.message}`, 'error', { title: '开奖记录未同步' });
        }
      }
      return null;
    } finally {
      setReceiptSyncing(receipt.id, false);
    }
  }

  async function copyToClipboard(text, successMessage) {
    if (!text.trim()) {
      showStatus('暂无中奖用户可复制。', 'error');
      return false;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const previousFocus = document.activeElement;
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand?.('copy');
        textarea.remove();
        previousFocus?.focus?.({ preventScroll: true });
        if (!copied) throw new Error('浏览器未允许复制');
      }
      showStatus(successMessage, 'success');
      return true;
    } catch (error) {
      showStatus(`复制失败：${error.message}`, 'error');
      return false;
    }
  }

  function exportCandidates(rows, evaluationByCandidate, view = {}) {
    if (!rows.length) {
      showStatus('当前视图没有可导出的候选。', 'error');
      return;
    }
    const exportedRows = rows.map((candidate, index) => {
      const evaluation = evaluationByCandidate.get(candidate);
      return {
        index: index + 1,
        uid: candidate.uid || '',
        screenName: candidate.screenName || '',
        text: candidate.text || '',
        createdAt: candidate.createdAt || '',
        source: friendlyProviderText(candidate.source) || candidate.source || '',
        status: evaluation?.eligible === false ? '已排除' : '可抽',
        exclusionReason: evaluation?.reasonLabel || '',
      };
    });
    const segmentName = { eligible: 'eligible', all: 'all', excluded: 'excluded' }[view.segment] || 'current';
    const searchSuffix = view.query ? '-search' : '';
    download(
      `weibo-candidates-${segmentName}${searchSuffix}-${Date.now()}.csv`,
      `\uFEFF${toCsv(exportedRows, ['index', 'uid', 'screenName', 'text', 'createdAt', 'source', 'status', 'exclusionReason'])}`,
    );
    showStatus(`已导出当前视图中的 ${rows.length.toLocaleString()} 位候选。`, 'success', {
      popup: true,
      title: '名单已导出',
    });
  }

  function exportHistoryBackup() {
    if (!drawHistory.length) {
      showStatus('暂无可导出的开奖记录。', 'error');
      return;
    }
    try {
      const date = new Date().toISOString().slice(0, 10);
      const backup = serializeDrawHistoryBackup(drawHistory, new Date().toISOString(), {
        maxBytes: MAX_HISTORY_BACKUP_BYTES,
      });
      const backupInfo = JSON.parse(backup);
      download(
        `weibo-draw-history-${date}.json`,
        backup,
        'application/json;charset=utf-8',
      );
      showStatus(`已备份 ${backupInfo.items.length} 条开奖记录${backupInfo.omittedCount ? `，因文件大小省略较早的 ${backupInfo.omittedCount} 条` : ''}。`, 'success', {
        popup: true,
        title: '记录已导出',
      });
    } catch (error) {
      showStatus(`记录导出失败：${error.message}`, 'error');
    }
  }

  async function importHistoryBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_HISTORY_BACKUP_BYTES) throw new Error('备份文件不能超过 2 MB');
      const imported = parseDrawHistoryBackup(await file.text());
      const merged = mergeDrawHistory(drawHistoryRef.current, imported);
      const stored = writeDrawHistory(window.localStorage, merged);
      if (!stored.ok) throw new Error('本机存储空间不足，无法保存恢复后的开奖记录。');
      setDrawHistory(stored.items);
      setHistoryUids(winnerIdsForStatus(stored.items, currentStatusId));
      setConfirmedSetup(null);
      clearResult();
      showStatus(`已读取 ${imported.length} 条备份，合并后保存 ${stored.items.length} 条记录${stored.dropped ? `，已舍弃较早的 ${stored.dropped} 条` : ''}。`, 'success', {
        popup: true,
        title: '记录已恢复',
      });
    } catch (error) {
      showStatus(`记录恢复失败：${error.message}`, 'error');
    } finally {
      event.target.value = '';
    }
  }

  function currentReceiptSnapshot() {
    return normalizeDrawReceipt({
      id: lastAudit?.candidateDigest ? `current-${lastAudit.candidateDigest}` : 'current-result',
      source,
      statusId: currentStatusId,
      statusUrl: currentStatusUrl || statusUrl.trim(),
      drawNumber: null,
      drawnAt: lastAudit?.drawnAt || '',
      results,
      candidateCount: candidates.length,
      eligibleCount: lastAudit?.eligibleCount ?? eligible.length,
      rules: lastAudit?.rules || null,
      sourceMeta: sourceMeta || {},
      seed: lastAudit?.seed || '',
      candidateDigest: lastAudit?.candidateDigest || '',
      recordState: lastAudit?.practice ? 'practice' : 'local',
    });
  }

  function resolveReceipt(receiptInput) {
    if (receiptInput?.nativeEvent) return selectedReceipt || currentReceiptSnapshot();
    if (receiptInput) return normalizeDrawReceipt(receiptInput);
    return selectedReceipt || currentReceiptSnapshot();
  }

  function copyReceiptPost(receiptInput, template = 'concise') {
    const receipt = resolveReceipt(receiptInput);
    copyToClipboard(
      buildAnnouncementText(receipt, template),
      '开奖文案已复制。',
    );
  }

  function copyReceiptFairness(receiptInput) {
    copyToClipboard(
      buildFairnessSummary(resolveReceipt(receiptInput)),
      '随机过程摘要已复制。',
    );
  }

  function copyReceiptWinners(receiptInput) {
    const text = receiptWinnerText(resolveReceipt(receiptInput));
    copyToClipboard(text, '获奖名单已复制。');
  }

  function exportReceiptWinners(receiptInput) {
    const receipt = resolveReceipt(receiptInput);
    const rows = receiptWinnerRows(receipt);
    if (!rows.length) {
      showStatus('暂无可导出的获奖名单。', 'error');
      return;
    }
    download(
      `weibo-winners-${receipt.statusId || Date.now()}.csv`,
      `\uFEFF${toCsv(rows, ['prize', 'rank', 'uid', 'screenName'])}`,
    );
    showStatus(`已导出 ${rows.length} 位获奖用户。`, 'success', { popup: true, title: '名单已导出' });
  }

  async function retrySaveReceipt(receiptInput) {
    const receipt = resolveReceipt(receiptInput);
    const saved = await saveResult({
      silent: false,
      updateCurrentTask: false,
      source: receipt.source,
      results: receipt.results,
      statusId: receipt.statusId,
      statusUrl: receipt.statusUrl,
      sourceMeta: receipt.sourceMeta,
      totalCount: receipt.candidateCount,
      eligibleCount: receipt.eligibleCount,
      audit: {
        seed: receipt.seed,
        drawnAt: receipt.drawnAt,
        statusId: receipt.statusId,
        statusUrl: receipt.statusUrl,
        rules: receipt.rules,
        candidateDigest: receipt.candidateDigest,
        eligibleCount: receipt.eligibleCount,
      },
    });
    if (!saved?.file) return;
    const manualDrawNumber = receipt.source === 'manual'
      ? manualDrawNumberFromSave(saved.drawNumber, drawHistory, receipt.id)
      : null;
    const updated = normalizeDrawReceipt({
      ...receipt,
      id: receipt.id,
      drawNumber: saved.drawNumber ?? manualDrawNumber,
      savedAt: saved.savedAt,
      auditHash: saved.auditHash,
      recordState: 'server',
    });
    setDrawHistory((history) => upsertDrawReceipt(history, updated));
    setSelectedReceipt((current) => current?.id === receipt.id ? updated : current);
    return updated;
  }

  async function createShareImage(receiptInput) {
    const receipt = resolveReceipt(receiptInput);
    if (!receipt.results.length) {
      showStatus('请先开奖，再生成开奖记录图。', 'error');
      return;
    }
    if (capturingRef.current) return;
    capturingRef.current = true;
    try {
      setIsCapturing(true);
      showStatus('正在生成开奖记录图。');
      await sleep(80);
      const providerText = [
        ...(Array.isArray(receipt.sourceMeta?.providers)
          ? receipt.sourceMeta.providers
          : [receipt.sourceMeta?.provider]).filter(Boolean),
        receipt.sourceMeta?.complete === false ? '仅含当前可见转发' : '',
      ].filter(Boolean).join(' / ');
      const { createResultPoster } = await import('./lib/resultPoster.js');
      const canvas = await createResultPoster({
        results: receipt.results,
        statusUrl: receipt.statusUrl,
        statusId: receipt.statusId,
        drawnAt: receipt.drawnAt || new Date(),
        seed: receipt.seed,
        auditHash: receipt.auditHash,
        candidateDigest: receipt.candidateDigest,
        candidateCount: receipt.candidateCount,
        eligibleCount: receipt.eligibleCount,
        winnerCount: receipt.total,
        drawCount: receipt.drawNumber
          ? drawCountCopy({
            source: receipt.source,
            count: receipt.drawNumber,
            completed: true,
          })
          : '未计入开奖次数',
        totalNumber: receipt.sourceMeta?.totalNumber,
        providerText,
        filterSummary: receipt.rules?.filters
          ? buildFilterSummary(receipt.rules.filters)
          : '未记录',
        prizeSummary: receipt.results
          .map((group) => `${group.prize.name} x ${group.winners.length}`)
          .join(' / '),
      }, {
        brandAssetUrl: publicAsset('avatar-96.webp'),
        avatarProxyBase: apiBase,
      });
      const imageBlob = await canvasBlob(canvas);
      const imageUrl = URL.createObjectURL(imageBlob);
      const imageName = `weibo-draw-record-${Date.now()}.png`;
      downloadUrl(imageName, imageUrl);
      window.setTimeout(() => URL.revokeObjectURL(imageUrl), 1000);
      showStatus('开奖记录图已生成。', 'success');
    } catch (error) {
      showStatus(`开奖记录图生成失败：${error.message}`, 'error');
    } finally {
      capturingRef.current = false;
      setIsCapturing(false);
    }
  }

  function addManualNames() {
    if (refuseWhileBusy()) return;
    if (source !== 'manual') {
      showStatus('请先选择手动名单。', 'error');
      return;
    }
    try {
      const parsed = parseManualInput(manualInput);
      if (!parsed.length) throw new Error('请先粘贴或导入候选名单。');
      const seen = new Set(candidates.map((item) => candidateIdentity(item)).filter(Boolean));
      const additions = [];
      for (const item of parsed) {
        const key = candidateIdentity(item);
        if (!key || seen.has(key)) continue;
        if (candidates.length + additions.length >= MAX_MANUAL_CANDIDATES) break;
        seen.add(key);
        additions.push(item);
      }
      if (!additions.length) {
        throw new Error(candidates.length >= MAX_MANUAL_CANDIDATES
          ? '手动名单已达到 20,000 人上限'
          : '这些候选已经在当前名单中');
      }
      if (!clearResult()) return;
      setConfirmedSetup(null);
      setCandidates((previous) => [...previous, ...additions]);
      setSourceMeta({
        provider: 'manual',
        loadedAt: new Date().toISOString(),
      });
      setLoadedSource('manual');
      setSourceInputDirty(false);
      setManualInput('');
      const reachedLimit = candidates.length + additions.length >= MAX_MANUAL_CANDIDATES;
      showStatus(`已添加 ${additions.length} 位候选用户${reachedLimit ? '，名单已达到 20,000 人上限' : ''}。`, 'success');
    } catch (error) {
      showStatus(error.message, 'error');
    }
  }
  async function importCandidateFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (manualFileReadRef.current) {
      event.target.value = '';
      showStatus('正在读取上一份名单文件，请稍候。');
      return;
    }
    manualFileReadRef.current = true;
    const inputRevision = candidateLoadRevisionRef.current;
    try {
      if (file.size > MAX_MANUAL_FILE_BYTES) throw new Error('文件不能超过 5 MB');
      const text = await file.text();
      if (!mountedRef.current || candidateLoadRevisionRef.current !== inputRevision) return;
      if (refuseWhileBusy()) return;
      if (source !== 'manual') {
        if (!changeSource('manual')) return;
      } else if (!clearResult()) {
        return;
      }
      updateManualInput(text);
      showStatus(`已读取 ${file.name}，确认后可导入候选名单。`, 'success', { popup: true, title: '文件已读取' });
    } catch (error) {
      showStatus(`文件读取失败：${error.message}`, 'error');
    } finally {
      manualFileReadRef.current = false;
      event.target.value = '';
    }
  }

  const manualDrawCountFromHistory = nextManualDrawNumber(drawHistory);
  const manualDrawLimitReached = manualDrawCountFromHistory === null
    || manualDrawSequenceRef.current >= Number.MAX_SAFE_INTEGER;
  const manualDrawCount = Math.max(
    manualDrawCountFromHistory === null ? Number.MAX_SAFE_INTEGER : Math.max(0, manualDrawCountFromHistory - 1),
    manualDrawSequenceRef.current,
  );
  const drawCountKnown = source === 'manual'
    || (drawCountStatus === 'ready' && Number.isFinite(Number(drawCount)) && Number(drawCount) >= 0);
  const previousDrawCount = source === 'manual'
    ? manualDrawCount
    : drawCountKnown
      ? Math.max(0, Math.floor(Number(drawCount)))
      : null;
  const nextDrawText = source === 'manual'
    ? manualDrawLimitReached
      ? '手动名单开奖次数已达上限'
      : `本机第 ${previousDrawCount + 1} 次手动开奖`
    : previousDrawCount === null
      ? '本链接下一次开奖（次数待核实）'
      : `本链接第 ${previousDrawCount + 1} 次开奖`;
  const activeReceipt = selectedReceipt?.drawnAt === lastAudit?.drawnAt
    ? selectedReceipt
    : lastAudit?.drawnAt
      ? drawHistory.find((item) => item.drawnAt === lastAudit.drawnAt)
      : null;
  const drawCountText = activeReceipt
    ? activeReceipt.drawNumber
      ? drawCountCopy({
        source: activeReceipt.source,
        count: activeReceipt.drawNumber,
        completed: true,
      })
      : '本次结果未计入次数'
    : source === 'manual'
      ? manualDrawLimitReached
        ? '手动名单开奖次数已达上限'
        : drawCountCopy({ source, count: manualDrawCount, completed: false })
      : !statusUrl.trim()
        ? '输入链接后显示'
        : drawCountStatus === 'loading'
          ? '正在查询记录'
          : drawCountStatus === 'error'
            ? '暂未查询到记录'
            : drawCount === null
              ? '输入有效链接后显示'
              : drawCountCopy({ source, count: drawCount, completed: false });
  const hasCandidates = candidates.length > 0;
  const hasResults = results.length > 0;
  const serverTryableAccountCount = Number(
    cookieInfo.tryableAccountCount
      ?? cookieInfo.availableAccountCount
      ?? cookieInfo.accountCount
      ?? cookieInfo.availableCookieCount
      ?? cookieInfo.cookieCount
      ?? 0,
  );
  const serverVerifiedAccountCount = Number(cookieInfo.verifiedAccountCount || 0);
  const accountStatusText = cookieHealth === 'error'
    ? '登录态状态暂不可用'
    : cookieHealth === 'checking'
      ? '正在读取登录态'
      : serverVerifiedAccountCount > 0
        ? `${serverVerifiedAccountCount} 个已验证服务器登录态`
        : serverTryableAccountCount > 0
          ? '服务器登录态已保存'
        : mobileCookie.trim()
          ? '已填写备用 Cookie'
          : '暂无服务器登录态';
  const serviceStatusText = progress
    ? '任务运行中'
    : apiHealth === 'ok'
      ? '连接正常'
      : apiHealth === 'error'
        ? '连接异常'
        : '正在检查';
  const loadedCandidateCount = candidates.length;
  const resultTotal = winners.length;
  const filterEnabledText = keyword.trim() || rules.mentionMin > 0 || blocklist.trim() || excludePrevious ? '已开启' : '默认';
  const filterSummary = buildFilterSummary({
    keyword,
    mentionMin: rules.mentionMin,
    uniqueByUser,
    excludePrevious,
    blocklistCount: rules.blocked.size,
  });
  const candidateLoadCompleted = Boolean(sourceMeta && loadedSource === source && !sourceInputDirty && !candidateLoadError);
  const candidateWarningText = candidateLoadWarning(sourceMeta);
  const loadedTime = shortLoadedTime(sourceMeta?.loadedAt);
  const candidateCutoff = candidateCutoffInfo(sourceMeta?.loadedAt);
  const candidateNeedsRefresh = source !== 'manual' && candidateCutoff.ageMs >= 2 * 60_000;
  const candidateFreshnessText = candidateLoadError
    ? '上次载入未完成，等待重新载入'
    : candidates.length && !candidateSourceReady
    ? '来源已修改，等待重新载入'
    : source === 'manual'
    ? loadedTime ? `${loadedTime} 更新` : '手动名单'
    : sourceMeta?.delivery === 'recent-snapshot'
      ? `复用 ${Math.max(1, Math.round(Number(sourceMeta.snapshotAgeMs || 0) / 1000))} 秒内名单`
      : sourceMeta?.delivery === 'shared-running'
        ? '共享载入完成'
           : loadedTime
           ? `${loadedTime} 更新`
           : '本次载入';
  const currentReceipt = hasResults ? currentReceiptSnapshot() : null;
  return (
    <AppleNavigationV3
      controller={{
        source,
        statusUrl,
        accessToken,
        mobileCookie,
        manualInput,
        candidates,
        candidateEvaluations,
        candidateSummary,
        eligible,
        prizes,
        normalizedPrizes,
        keyword,
        mentionMin: rules.mentionMin,
        blocklist,
        uniqueByUser,
        excludePrevious,
        results,
        winners,
        drawHistory,
        selectedReceipt,
        currentReceipt,
        cookieInfo,
        status,
        statusTone,
        progress,
        isLoading,
        isDrawing,
        isBusy,
        rollingCandidate,
        phase,
        activeTab,
        showSourceEditor,
        showPrizeEditor,
        showDrawConfirm,
        showFilters,
        candidateQuery,
        candidateSegment,
        historyExpanded,
        historyQuery,
        showSettings,
        settingsTarget,
        showGuide,
        showFeedback,
        feedbackInitialCategory,
        legalDocument,
        notice,
        confirmAction,
        apiBase,
        apiBaseInput,
        apiKey,
        totalSlots,
        hasCandidates,
        hasResults,
        loadedCandidateCount,
        resultTotal,
        filterEnabledText,
        accountStatusText,
        serviceStatusText,
        drawCountText,
        previousDrawCount,
        nextDrawText,
        drawSetupConfirmed,
        candidateSourceReady,
        filterSummary,
        candidateLoadCompleted,
        candidateLoadError,
        candidateWarningText,
        candidateFreshnessText,
        candidateCutoffLabel: source === 'manual' ? `手动名单 · ${candidateCutoff.label}` : candidateCutoff.label,
        candidateNeedsRefresh,
        cooldownPersistent,
        historyStorageAvailable,
        syncingReceiptIds,
        manualCookieOpen,
        isCapturing,
        motionPreference,
        homeStatusInputRef,
        candidateStatusInputRef,
        sourceSheetStatusInputRef,
        historyImportInputRef,
        firstPrizeNameRef,
        setSource: changeSource,
        setStatusUrl,
        setAccessToken: setAccessTokenSafe,
        setMobileCookie: setMobileCookieSafe,
        updateManualInput,
        applyFilterDraft,
        setSelectedReceipt: selectReceipt,
        setActiveTab: setActiveTabSafe,
        setShowSourceEditor: setShowSourceEditorSafe,
        setShowPrizeEditor: setShowPrizeEditorSafe,
        setShowDrawConfirm: setShowDrawConfirmSafe,
        setShowFilters: setShowFiltersSafe,
        setCandidateQuery,
        setCandidateSegment,
        setHistoryExpanded,
        setHistoryQuery,
        setShowSettings: setShowSettingsSafe,
        setShowGuide: setShowGuideSafe,
        setShowFeedback: setShowFeedbackSafe,
        setLegalDocument: setLegalDocumentSafe,
        setConfirmAction,
        setApiBase: setApiBaseSafe,
        setApiBaseInput: updateApiBaseInput,
        commitApiBase,
        setApiKey: setApiKeySafe,
        setManualCookieOpen,
        setMotionPreference,
        openSettings,
        dismissNotice,
        applySettingsAction,
        openLegalDocument,
        openFeedback,
        submitFeedback,
        selectCandidateSource,
        updateStatusInput,
        shouldForceCandidateRefresh,
        safeLoadCandidates,
        pasteAndLoadCandidates,
        handleStatusPaste,
        cancelCandidateLoad,
        clearResult,
        updatePrize,
        updatePrizeCount,
        commitPrizeCount,
        addPrize,
        removePrize,
        confirmDrawSetup,
        requestDraw,
        confirmAndDraw,
        cancelDraw,
        loadCookieStatus,
        testApiConnection,
        drawAll,
        showStatus,
        importCandidateFile,
        addManualNames,
        exportCandidates,
        exportHistoryBackup,
        importHistoryBackup,
        createShareImage,
        copyToClipboard,
        copyReceiptPost,
        copyReceiptFairness,
        copyReceiptWinners,
        exportReceiptWinners,
        retrySaveReceipt,
      }}
    />
  );
}

export default App;
