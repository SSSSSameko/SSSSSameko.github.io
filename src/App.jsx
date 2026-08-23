import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BadgeCheck,
  BookOpen,
  ChevronRight,
  CheckCircle2,
  CircleHelp,
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
  cleanApiBase,
  digestCandidates,
  friendlyProviderText,
  parseManualInput,
  randomSeedHex,
  readStoredValue,
  safeMentionName,
  seededShuffle,
  toCsv,
  writeStoredValue,
} from './lib/appCore.js';
import CandidateAvatar from './components/CandidateAvatar.jsx';
import DrawResultSheet from './components/DrawResultSheet.jsx';
import {
  cancelDrawDeckMotion,
  settleDrawDeckMotion,
  startDrawDeckMotion,
} from './lib/drawDeckMotion.js';
import {
  buildFairnessSummary,
  drawCountCopy,
  normalizeDrawReceipt,
  readDrawHistory,
  upsertDrawReceipt,
  winnerIdsForStatus,
  writeDrawHistory,
} from './lib/drawReceipts.js';
import { createResultPoster } from './lib/resultPoster.js';
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MAX_LENGTH,
  normalizeFeedbackSubmission,
} from './lib/feedback.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const publicAsset = (name) => `${import.meta.env.BASE_URL}${name}`;
const APP_VERSION = '3.0.0';
const REPOST_JOB_TIMEOUT_MS = 90 * 60 * 1000;
const REPOST_JOB_POLL_MS = 1200;
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

function download(name, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
function downloadUrl(name, url) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
}
function winnerMentionText(winners) {
  return winners.map((winner) => safeMentionName(winner.screenName || winner.uid)).filter(Boolean).map((name) => `@${name}`).join(' ');
}
function winnerPostText(results, statusUrl) {
  const lines = results
    .filter((item) => item.winners.length)
    .map((item) => `${item.prize.name}：${winnerMentionText(item.winners)}`);
  const linkLine = statusUrl ? `\n原微博：${statusUrl}` : '';
  return `本次微博转发抽奖结果如下：\n${lines.join('\n')}${linkLine}\n请中奖用户留意私信。`;
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
  return MOTION_OPTIONS.some((option) => option.value === stored) ? stored : 'full';
}

function shouldReduceMotion(preference) {
  if (preference === 'full') return false;
  if (preference === 'reduced') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const GUIDE_STEPS = [
  ['1', '载入候选', '粘贴微博正文链接、mid 或 bid。你填写的 Cookie 优先使用，留空时使用服务器登录态。'],
  ['2', '核对名单', '确认候选人数和筛选结果。你也可以手动填写名单，或导入 CSV、TXT、TSV 和 JSON 文件。'],
  ['3', '确认抽奖设置', '检查奖项顺序、中奖人数和筛选规则。中奖总人数不能超过可抽人数。'],
  ['4', '开奖并保存', '点击“开始抽奖”。完成后可查看公平记录、保存结果图或复制公示文案。'],
];

const UPDATE_LOGS = [
  {
    version: '3.0.0',
    date: '2026 年 8 月 23 日',
    label: '当前版本',
    title: '全面优化操作体验与服务器稳定性',
    items: [
      '优化UI',
      '完善候选载入、错误提示、开奖结果和开奖记录',
      '修复 JSON 名单导入时昵称被拆开的问题',
      '新增 意见反馈',
    ],
  },
  {
    version: '2.1.0',
    date: '2026 年 7 月 25 日',
    label: '历史版本',
    title: '完善正式使用时的开奖体验',
    items: [
      '优化动画、结果图和方便直接发微博的文案',
      '增加真实微博头像，并优化昵称、UID 和奖项排版',
    ],
  },
  {
    version: '2.0.0',
    date: '2026 年 7 月 24 日',
    label: '历史版本',
    title: '重新设计移动端抽奖工作台',
    items: ['UI重新设计，使用Tab Bar', '增加本链接开奖次数、完整开奖结果弹窗'],
  },
  {
    version: '1.2.0',
    date: '2026 年 7 月 2 日',
    label: '历史版本',
    title: '优化云端版本',
    items: [],
  },
  {
    version: '1.1.2',
    date: '2026 年 6 月 4 日',
    label: '历史版本',
    title: '完善后台与无登录抓取',
    items: ['后台管理', '增加抓取队列、任务进度和并发限制', '完善公开部署和基础安全保护'],
  },
  {
    version: '1.0.1',
    date: '2026 年 5 月 29 日',
    label: '历史版本',
    title: '在线部署微博抽奖助手',
    items: ['支持通过微博链接获取公开可见的转发候选', '增加手动名单、微博 H5 和官方接口等候选来源', '增加结果图、CSV 导出和服务器记录'],
  },
  {
    version: '0.0.1',
    date: '2026 年 5 月 22 日',
    label: '历史版本',
    title: '完成最初的抽奖工具',
    items: ['支持粘贴或导入名单', '支持去重、关键词、排除名单、中奖和候补设置', '增加随机种子、开奖记录和结果导出'],
  },
];

const LEGAL_DOCUMENTS = {
  about: {
    key: 'about',
    title: '关于此应用',
    subtitle: `版本 ${APP_VERSION} · by.sameko`,
    sections: [
      ['用途', '用于整理微博转发候选、设置筛选与奖项、随机抽取并保存开奖记录。'],
      ['数据范围', '微博候选以载入时公开可见的转发数据为准。手动名单由活动主办方自行核对。'],
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
    title: '免责声明',
    subtitle: '服务边界与使用责任',
    sections: [
      ['候选数据', '候选名单取决于载入时公开可见的数据和当前筛选规则。不可见转发、平台限制、网络异常和账号权限可能影响名单完整性。'],
      ['开奖结果', '本应用使用带随机种子的 Fisher-Yates 洗牌生成结果，并保存名单摘要和过程哈希。相关记录用于复查本次流程，不代表微博或其他第三方认证，也不是不可伪造的服务端证明。'],
      ['筛选范围', '“排除已中奖用户”只针对当前浏览器中的当前任务和已保存本机记录，不代表跨设备、跨用户或跨活动的全局限制。'],
      ['主办方责任', '活动主办方应在开奖前核对候选、奖项和筛选规则，并负责活动规则、结果公示、奖品发放、税费及其他法定义务。'],
      ['账号安全', '请只使用本人有权使用的微博 Cookie。不要在公共设备或他人可访问的页面中填写 Cookie。'],
      ['服务可用性', '平台接口调整、网络故障、服务器维护或不可抗力可能导致服务中断、数据不完整或记录保存失败。请在公示前下载结果并核对保存状态。'],
      ['法律说明', '本说明介绍工具边界，不构成法律意见。活动合规要求请咨询具有相应资质的专业人士。'],
    ],
  },
  privacy: {
    title: '隐私政策',
    subtitle: '候选、Cookie 与记录如何处理',
    sections: [
      ['处理目的', '本应用处理候选数据，用于载入转发名单、应用筛选规则、完成抽奖和生成开奖记录。'],
      ['处理的数据', '处理内容包括微博链接、公开可见的转发信息、筛选条件、奖项和结果。候选信息可能包含昵称、UID、头像地址、转发文本和时间。'],
      ['Cookie', '你填写的 Cookie 仅用于当前载入任务。服务器会在任务队列中临时处理该内容，但不会写入服务器 Cookie 池或浏览器长期存储。留空时使用服务器登录态。'],
      ['浏览器存储', '浏览器保存最近开奖记录、界面动效偏好和可信的后端地址。候选、奖项、筛选条件、访问密钥和 Cookie 会在刷新页面后清除。'],
      ['服务器记录', '开奖完成后，服务器保存微博标识、候选统计、名单摘要、筛选规则、随机记录和获奖结果，用于统计开奖次数和复查记录。服务器 Cookie 由站长单独管理。'],
      ['意见反馈', '提交意见反馈时，服务器保存反馈分类、正文、提交时间和匿名来源标识，供站长排查问题与改进功能。反馈不收集联系方式，也不提供站内回复。'],
      ['公开与分享', '保存结果图或复制公示文案前，请确认你有权公开获奖者昵称、UID、头像及其他相关信息。'],
      ['删除与控制', '你可以在“更多”中的“数据设置”清空当前数据、本次 Cookie 和本机开奖记录。服务器开奖记录由站长在后台维护。'],
    ],
  },
  terms: {
    title: '用户协议',
    subtitle: '使用规则与禁止事项',
    sections: [
      ['使用条件', '请在法律法规、微博平台规则和活动规则允许的范围内使用本应用，并确保活动与奖品安排真实、可履行。'],
      ['账号授权', '只能填写你有权使用的 Cookie 或访问令牌。不得盗用账号、绕过平台安全措施或干扰微博服务。'],
      ['数据使用', '不得非法收集、出售、披露或滥用候选信息，也不得使用本应用批量骚扰他人。'],
      ['开奖诚信', '不得篡改候选名单、筛选规则、随机记录或开奖结果，不得使用本应用制造虚假公示。'],
      ['开奖确认', '点击“开始抽奖”表示你已确认候选范围、筛选条件、奖项顺序和名额。随机种子、名单摘要和过程哈希用于复查，不代表第三方认证。'],
      ['结果履行', '活动主办方负责联系获奖者、核验资格、发放奖品并处理活动争议。'],
    ],
  },
  copyright: {
    title: '版权说明',
    subtitle: '应用、用户与平台内容',
    sections: [
      ['应用内容', '除开源组件及另有说明的内容外，本应用的界面、文字与程序代码由相应权利人保留权利。'],
      ['用户与平台内容', '微博昵称、头像、转发内容和活动素材的权利归原权利人所有。本工具仅为完成抽奖流程而展示和处理这些信息。'],
      ['商标', '“微博”及相关标识属于其权利人。本工具为独立辅助工具，不代表微博官方提供、赞助或背书。'],
    ],
  },
  licenses: {
    title: '开源许可',
    subtitle: '第三方软件与许可证',
    sections: [
      ['MIT License', 'React、React DOM、Vite、Vite React 插件、PostCSS 和 Autoprefixer。'],
      ['ISC License', 'Lucide React 图标库。'],
      ['Apache License 2.0', 'Playwright 浏览器自动化工具。'],
      ['许可优先', '第三方软件的使用以各项目随附的许可证和版权声明为准。'],
    ],
  },
};

const I = {
  users: <Users className="icon-18" strokeWidth={1.5} />,
  listChecks: <ListChecks className="icon-18" strokeWidth={1.65} />,
  book: <BookOpen className="icon-18" strokeWidth={1.7} />,
  chevron: <ChevronRight className="icon-16" strokeWidth={1.8} />,
  help: <CircleHelp className="icon-16" strokeWidth={1.8} />,
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
};

function keepFocusInDialog(event, dialog) {
  if (event.key !== 'Tab' || !dialog) return;
  const controls = [...dialog.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

  useEffect(() => {
    const previousFocus = document.activeElement;
    actionRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
      keepFocusInDialog(event, dialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div className="v3-alert-backdrop" role="presentation" onClick={onClose}>
      <section ref={dialogRef} className="v3-alert-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`notice-${notice.id}`} onClick={(event) => event.stopPropagation()}>
        <span className="v3-alert-icon">{I.alert}</span>
        <h2 id={`notice-${notice.id}`}>{notice.title}</h2>
        <p>{notice.message}</p>
        <button ref={actionRef} type="button" onClick={onClose}>知道了</button>
      </section>
    </div>
  );
}

function NoticeToast({ notice, onClose }) {
  if (!notice) return null;
  if (notice.tone === 'error') return <ErrorNoticeDialog notice={notice} onClose={onClose} />;
  const icon = notice.tone === 'success' ? I.check : I.alert;
  return (
    <div className={`flow-notice flow-notice-${notice.tone || 'neutral'}`} role="alert" aria-live="assertive">
      <span className="flow-notice-icon">{icon}</span>
      <div>
        <strong>{notice.title}</strong>
        <p>{notice.message}</p>
      </div>
      <button type="button" aria-label="关闭提示" onClick={onClose}>{I.close}</button>
    </div>
  );
}

function SheetFrame({ title, subtitle, icon, onClose, children, className = '' }) {
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onCloseRef.current?.();
      keepFocusInDialog(event, dialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, []);

  return (
    <div className="flow-sheet-backdrop" onClick={onClose}>
      <div ref={dialogRef} className={`flow-sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="flow-sheet-grabber" aria-hidden="true" />
        <div className="flow-sheet-head">
          <div className="flow-sheet-title">
            <span>{icon}</span>
            <div>
              <h2>{title}</h2>
              {subtitle && <p>{subtitle}</p>}
            </div>
          </div>
          <button ref={closeButtonRef} type="button" aria-label={`关闭${title}`} onClick={onClose} className="flow-sheet-close">{I.close}</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function GuideSheet({ onClose }) {
  return (
    <SheetFrame title="使用教程" subtitle="从载入候选到保存结果" icon={I.book} onClose={onClose} className="flow-guide-sheet">
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
      <button type="button" onClick={onClose} className="flow-sheet-primary v3-primary-action">知道了</button>
    </SheetFrame>
  );
}

function FeedbackSheet({ onClose, onSubmit }) {
  const [category, setCategory] = useState(FEEDBACK_CATEGORIES[0].value);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const textareaRef = useRef(null);

  useEffect(() => {
    const timer = window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 360);
    return () => window.clearTimeout(timer);
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    try {
      const payload = normalizeFeedbackSubmission({ category, content });
      setSubmitting(true);
      await onSubmit(payload);
      setSent(true);
    } catch (submitError) {
      setError(submitError.message || '反馈暂时未能送达，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SheetFrame title="意见反馈" subtitle="你的建议会由站长直接查看" icon={I.feedback} onClose={onClose} className="flow-feedback-sheet">
      {sent ? (
        <div className="feedback-success" role="status">
          <span>{I.check}</span>
          <h3>谢谢你的反馈</h3>
          <p>内容已经送达，站长会在后台查看。</p>
          <button type="button" className="flow-sheet-primary v3-primary-action" onClick={onClose}>完成</button>
        </div>
      ) : (
        <form className="feedback-form" onSubmit={submit}>
          <fieldset className="feedback-category">
            <legend>反馈类型</legend>
            <div>
              {FEEDBACK_CATEGORIES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={category === item.value ? 'is-active' : ''}
                  aria-pressed={category === item.value}
                  onClick={() => setCategory(item.value)}
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
              placeholder="请描述你的建议或遇到的问题…"
              onChange={(event) => {
                setContent(event.target.value);
                if (error) setError('');
              }}
              aria-describedby={`feedback-hint${error ? ' feedback-error' : ''}`}
            />
            <span className="feedback-count">{content.length} / {FEEDBACK_MAX_LENGTH}</span>
          </label>

          <p className="feedback-privacy" id="feedback-hint">{I.shield} 请勿填写 Cookie、密码等敏感信息</p>
          {error && <p className="feedback-error" id="feedback-error" role="alert">{error}</p>}
          <button type="submit" className="flow-sheet-primary v3-primary-action feedback-submit" disabled={submitting || content.trim().length < 2}>
            {submitting ? I.refresh : I.send}
            <span>{submitting ? '正在提交' : '提交反馈'}</span>
          </button>
        </form>
      )}
    </SheetFrame>
  );
}

function LegalSheet({ document, onClose, onOpenUpdates }) {
  if (!document) return null;
  return (
    <SheetFrame key={document.key || document.title} title={document.title} subtitle={document.subtitle} icon={document.key === 'updates' ? I.history : I.file} onClose={onClose} className="flow-legal-sheet">
      <p className="flow-legal-date">更新日期：{document.key === 'updates' || document.key === 'about' ? '2026 年 8 月 23 日' : '2026 年 8 月 22 日'}</p>
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
            <button type="button" className="flow-legal-update-link list-row" onClick={onOpenUpdates}>
              <span className="row-icon mint">{I.history}</span>
              <span className="row-copy"><strong>更新日志</strong><small>查看 {APP_VERSION} 与历史正式版本</small></span>
              {I.chevron}
            </button>
          )}
        </>
      )}
      <button type="button" onClick={onClose} className="flow-sheet-primary v3-primary-action">完成</button>
    </SheetFrame>
  );
}

function SectionTitle({ eyebrow, title, action, onAction }) {
  return (
    <header className="section-header">
      <div>
        {eyebrow && <span>{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {action && <button type="button" onClick={onAction}>{action}</button>}
    </header>
  );
}

function AppListRow({ icon, tone = 'blue', title, detail, value, onClick }) {
  return (
    <button className="list-row" type="button" onClick={onClick}>
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
  const [tabDirection, setTabDirection] = useState('forward');
  const drawDeckRef = useRef(null);
  const drawSceneRef = useRef(null);
  const deckAnimationsRef = useRef([]);
  const previousDrawStateRef = useRef(drawState);

  useEffect(() => {
    const reducedMotion = shouldReduceMotion(c.motionPreference);
    const deck = drawDeckRef.current;
    const previousState = previousDrawStateRef.current;
    cancelDrawDeckMotion(deckAnimationsRef.current);
    deckAnimationsRef.current = [];

    if (drawState === 'running') {
      deckAnimationsRef.current = startDrawDeckMotion(deck, { reducedMotion });
    } else if (drawState === 'finished' && previousState === 'running') {
      deckAnimationsRef.current = settleDrawDeckMotion(deck, { reducedMotion });
    }
    previousDrawStateRef.current = drawState;
  }, [drawState, c.motionPreference]);

  useEffect(() => () => {
    cancelDrawDeckMotion(deckAnimationsRef.current);
  }, []);

  const tabIndex = { home: 0, candidates: 1, history: 2, more: 3 }[c.activeTab] ?? 0;
  const identityOf = (candidate) => String(
    candidate?.uid || candidate?.screenName || candidate?.id || '',
  ).toLowerCase();
  const eligibleIds = new Set(c.eligible.map(identityOf));
  const excludedCandidates = c.candidates.filter((candidate) => !eligibleIds.has(identityOf(candidate)));
  const segmentCandidates = c.candidateSegment === 'all'
    ? c.candidates
    : c.candidateSegment === 'excluded'
      ? excludedCandidates
      : c.eligible;
  const query = c.candidateQuery.trim().toLowerCase();
  const visibleCandidates = segmentCandidates
    .filter((candidate) => !query || [
      candidate.screenName,
      candidate.uid,
      candidate.text,
    ].some((value) => String(value || '').toLowerCase().includes(query)))
    .slice(0, 100);
  const visibleHistory = c.historyExpanded ? c.drawHistory : c.drawHistory.slice(0, 3);
  const totalHistoricWinners = c.drawHistory.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const latestHistory = c.drawHistory.slice(0, 2);
  const sourceDetail = {
    mobile: '微博公开可见转发',
    manual: '粘贴、填写或文件导入',
    official: '微博官方接口',
  }[c.source];
  const stageCandidate = c.isDrawing
    ? c.rollingCandidate || c.eligible[0] || c.candidates[0]
    : c.eligible[0] || c.candidates[0];
  const primaryResult = c.results.find((item) => item.winners?.length);
  const primaryWinner = primaryResult?.winners?.[0];
  const visibleWinners = c.results
    .flatMap((item) => item.winners.map((winner) => ({
      candidate: winner,
      prizeName: item.prize.name,
    })))
    .slice(0, 4);
  const stageName = stageCandidate?.screenName || stageCandidate?.uid || '候选用户';
  const compactUid = (candidate) => {
    const uid = String(candidate?.uid || '');
    if (!uid) return friendlyProviderText(candidate?.source) || '微博候选';
    return uid.length > 8 ? `UID ${uid.slice(0, 4)}••••${uid.slice(-2)}` : `UID ${uid}`;
  };

  const switchTab = (tab) => {
    const tabOrder = { home: 0, candidates: 1, history: 2, more: 3 };
    if (tab !== c.activeTab) {
      setTabDirection(tabOrder[tab] > tabOrder[c.activeTab] ? 'forward' : 'backward');
    }
    c.setActiveTab(tab);
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-root-view="${tab}"] .root-scroll`)?.scrollTo({
        top: 0,
        behavior: shouldReduceMotion(c.motionPreference) ? 'auto' : 'smooth',
      });
    });
  };

  const startDraw = () => {
    const reducedMotion = shouldReduceMotion(c.motionPreference);
    drawSceneRef.current?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'center',
    });
    c.drawAll();
  };

  return (
    <div
      className="app-shell v3-app-shell"
      data-draw-state={drawState}
      data-motion={c.motionPreference}
      data-root-tab={c.activeTab === 'home' ? 'draw' : c.activeTab}
      data-tab-direction={tabDirection}
    >
      <header className="root-navbar glass">
        <button className="brand-button" type="button" onClick={() => switchTab('more')}>
          <img src={publicAsset('avatar.jpg')} alt="" />
          <span>
            <strong>微博转发抽奖</strong>
            <small>by.sameko</small>
          </span>
        </button>
        <div className="navbar-actions">
          <button type="button" onClick={() => c.setShowGuide(true)} aria-label="使用教程">
            {I.book}
          </button>
          <button type="button" onClick={() => c.setShowSettings(true)} aria-label="设置">
            {I.settings}
          </button>
        </div>
      </header>

      <NoticeToast notice={c.notice} onClose={c.dismissNotice} />

      <main className="root-pages">
        <section className={`root-view ${c.activeTab === 'home' ? 'is-active' : ''}`} data-root-view="home" hidden={c.activeTab !== 'home'}>
          <div className="root-scroll">
            <section className={`draw-studio ${!c.hasCandidates ? 'is-empty' : ''}`} aria-label="抽奖控制台">
              <header className="studio-header">
                <div>
                  <span className={`title-status ${c.isLoading || c.isDrawing ? 'is-busy' : ''}`}>
                    <i />
                    {c.isLoading
                      ? '正在载入候选'
                      : c.isDrawing
                      ? '正在抽取'
                        : c.hasResults
                          ? '本轮开奖已完成'
                          : c.hasCandidates
                         ? '已准备开奖'
                            : '等待载入候选'}
                  </span>
                  <strong>
                    {c.hasCandidates
                      ? `${c.eligible.length.toLocaleString()} 名候选 · ${c.normalizedPrizes.length} 个奖项 · ${c.totalSlots} 个名额`
                      : '粘贴微博链接即可载入'}
                  </strong>
                </div>
                <button type="button" onClick={() => c.setShowFilters(true)}>
                  {I.listChecks}
                  筛选
                </button>
              </header>

              {!c.hasCandidates ? (
                <>
                  <div className="draw-scene v3-intake-scene">
                    <div className="scene-geometry" aria-hidden="true"><i /><i /></div>
                    <div className="scene-glint" aria-hidden="true" />
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
                          <span key={stageCandidate?.id || stageCandidate?.uid || stageCandidate?.screenName || 'candidate'}>
                            <small>微博转发名单</small>
                            <strong>等待链接</strong>
                            <em>载入后会显示符合条件的候选</em>
                          </span>
                        </div>
                        <footer>
                          <span><small>来源</small><strong>微博转发</strong></span>
                          <span><small>载入</small><strong>链接识别</strong></span>
                          <span><small>状态</small><strong>待载入</strong></span>
                        </footer>
                      </article>
                    </div>
                  </div>
                  <div className="v3-intake-controls">
                    <label className="v3-link-field">
                      <span className="sr-only">微博链接、mid 或 bid</span>
                      <input
                        ref={c.statusInputRef}
                        value={c.statusUrl}
                        onChange={(event) => {
                          c.setStatusUrl(event.target.value);
                          c.setCurrentStatusUrl(event.target.value);
                        }}
                        onPaste={c.handleStatusPaste}
                        name="weiboStatusUrl"
                        autoComplete="off"
                        inputMode="url"
                        placeholder="粘贴微博正文链接、mid 或 bid"
                      />
                      {c.statusUrl.trim() && (
                        <button
                          type="button"
                          aria-label="清空微博链接"
                          onClick={() => {
                            c.setStatusUrl('');
                            c.setCurrentStatusUrl('');
                            c.statusInputRef.current?.focus();
                          }}
                        >
                          {I.close}
                        </button>
                      )}
                    </label>
                    <button
                      className="primary-button v3-load-button v3-primary-action"
                      type="button"
                      onClick={c.pasteAndLoadCandidates}
                      disabled={c.isLoading}
                    >
                      <span className="draw-button-icon">{c.isLoading ? I.refresh : I.link}</span>
                      <span>
                        <strong>{c.isLoading ? '正在载入候选' : c.statusUrl.trim() ? '载入候选' : '粘贴链接并载入'}</strong>
                        <small>优先使用已填写的 Cookie</small>
                      </span>
                      {I.chevron}
                    </button>
                    <button className="v3-text-action" type="button" onClick={() => c.selectCandidateSource('manual')}>
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
                          <span>{c.isDrawing ? '正在抽取候选' : '候选'}</span>
                          {I.shield}
                        </header>
                        <div className="pass-identity">
                          <CandidateAvatar candidate={stageCandidate} className="pass-avatar" apiBase={c.apiBase} />
                          <span>
                            <small>{c.isDrawing ? c.phase || '正在抽取' : '候选已载入'}</small>
                            <strong>{c.isDrawing ? stageName : c.eligible.length.toLocaleString()}</strong>
                            <em>{c.isDrawing ? compactUid(stageCandidate) : '名候选'}</em>
                          </span>
                        </div>
                        <footer>
                          <span><small>奖项</small><strong>{c.normalizedPrizes.length} 个</strong></span>
                          <span><small>名额</small><strong>{c.totalSlots} 名</strong></span>
                          <span><small>状态</small><strong>{c.isDrawing ? '抽取中' : c.eligible.length ? '可开奖' : '需调整'}</strong></span>
                        </footer>
                      </article>
                      <article className="candidate-pass winner-core" aria-hidden={!c.hasResults}>
                        <header>
                          <span>中奖结果</span>
                          {I.badgeCheck}
                        </header>
                        <div className="pass-identity">
                          <CandidateAvatar candidate={primaryWinner} className="pass-avatar" apiBase={c.apiBase} />
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
                      <span><i /><b>{c.isDrawing ? '抽取中' : c.hasResults ? '已完成' : '待开始'}</b></span>
                      <small>微博抽奖</small>
                    </div>
                    <div className="result-rail" aria-label="中奖结果">
                      <header>
                        <div>
                          <span>开奖结果</span>
                          <strong>{c.resultTotal} 名幸运用户</strong>
                        </div>
                        <button type="button" onClick={() => c.setSelectedReceipt(c.drawHistory[0] || null)}>查看结果</button>
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
                            <CandidateAvatar candidate={candidate} className={`avatar ${['pink', 'blue', 'lilac', 'mint'][index % 4]}`} apiBase={c.apiBase} />
                            <strong>{candidate.screenName || candidate.uid || `获奖用户 ${index + 1}`}</strong>
                            <small>{prizeName}</small>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="draw-specs">
                    <button type="button" onClick={() => c.setShowSourceEditor(true)}>
                      <span className="spec-icon blue">{I.users}</span>
                      <span><small>候选</small><strong>{c.eligible.length.toLocaleString()}</strong></span>
                    </button>
                    <button type="button" onClick={() => c.setShowPrizeEditor(true)}>
                      <span className="spec-icon coral">{I.gift}</span>
                      <span><small>奖项</small><strong>{c.normalizedPrizes.length} 个</strong></span>
                    </button>
                    <button type="button" onClick={() => c.setShowFilters(true)}>
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
                        onClick={c.eligible.length ? startDraw : () => c.setShowFilters(true)}
                        disabled={c.isDrawing || c.isLoading}
                      >
                        <span className="draw-button-icon">{c.eligible.length ? I.shuffle : I.listChecks}</span>
                        <span>
                          <strong>{c.eligible.length ? '开始抽奖' : '调整筛选'}</strong>
                          <small>
                            {c.eligible.length
                              ? `将抽取 ${c.totalSlots} 位用户`
                              : '当前没有符合条件的候选'}
                          </small>
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
                    </div>
                    <div className="draw-control-state draw-finished">
                      <div>
                        <span className="complete-icon">{I.check}</span>
                        <span><small>开奖完成</small><strong>{c.drawCountText}</strong></span>
                      </div>
                      <div className="result-buttons">
                        <button type="button" aria-label="再次抽奖" onClick={startDraw}>{I.shuffle}</button>
                        <button type="button" aria-label="查看开奖结果" onClick={() => c.setSelectedReceipt(c.drawHistory[0] || null)}>{I.clock}</button>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {c.progress && (
                <div className="v3-progress">
                  <span>{c.progress.message || '正在处理'}</span>
                  <strong>{Math.round(c.progress.percent || 0)}%</strong>
                  <i style={{ '--progress-scale': Math.max(0, Math.min(100, Number(c.progress.percent || 0))) / 100 }} />
                </div>
              )}
            </section>

            <section className="content-section">
              <SectionTitle eyebrow="开奖前确认" title="抽奖设置" />
              <div className="grouped-list">
                <AppListRow
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
                eyebrow="最近完成"
                title="开奖记录"
                action={c.drawHistory.length ? '查看全部' : ''}
                onAction={() => switchTab('history')}
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
                      <time>{String(item.time || '').slice(5, 10).replace('-', '.')}</time>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="v3-section-empty">
                  <span>{I.clock}</span>
                  <div><strong>暂无开奖记录</strong><small>完成开奖后将自动保存在这里</small></div>
                </div>
              )}
            </section>
            <div className="bottom-space" />
          </div>
        </section>

        <section className={`root-view ${c.activeTab === 'candidates' ? 'is-active' : ''}`} data-root-view="candidates" hidden={c.activeTab !== 'candidates'}>
          <div className="root-scroll">
            <header className="large-title">
              <span className={`title-status ${c.hasCandidates ? '' : 'neutral'}`}><i /> {c.hasCandidates ? '名单已载入' : '尚未载入候选'}</span>
              <h1>候选名单</h1>
              <p>{c.hasCandidates ? `${c.eligible.length.toLocaleString()} 人符合当前筛选规则` : '从微博载入，也可手动填写或导入文件'}</p>
            </header>

            <section className="content-section v3-source-section">
              <SectionTitle eyebrow="候选来源" title="载入名单" action={c.hasCandidates ? '刷新' : ''} onAction={() => c.safeLoadCandidates({ jumpAfterLoad: false })} />
              <div className="segmented-control v3-source-control">
                {SOURCE_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    className={c.source === value ? 'is-active' : ''}
                    onClick={() => c.setSource(value)}
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
                      ref={c.activeTab === 'candidates' ? c.statusInputRef : null}
                      value={c.statusUrl}
                      onChange={(event) => {
                        c.setStatusUrl(event.target.value);
                        c.setCurrentStatusUrl(event.target.value);
                      }}
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
                    <span><strong>{c.accountStatusText}</strong><small>留空时使用服务器登录态</small></span>
                    <button type="button" onClick={() => c.loadCookieStatus(true)}>校验</button>
                  </div>
                  <button className="v3-disclosure" type="button" onClick={() => c.setManualCookieOpen((value) => !value)} aria-expanded={c.manualCookieOpen}>
                    <span>使用自己的 Cookie（优先）</span>
                    <span>{c.manualCookieOpen ? '收起' : '展开'} {I.chevron}</span>
                  </button>
                  {c.manualCookieOpen && (
                    <textarea
                      className="v3-textarea"
                      value={c.mobileCookie}
                      onChange={(event) => c.setMobileCookie(event.target.value)}
                      name="mobileCookie"
                      aria-label="用户微博 Cookie"
                      placeholder="仅用于本次载入任务；留空时使用服务器登录态。"
                    />
                  )}
                </div>
              )}

              {c.source === 'manual' && (
                <div className="v3-source-form">
                  <textarea
                    className="v3-textarea v3-list-input"
                    value={c.manualInput}
                    onChange={(event) => c.setManualInput(event.target.value)}
                    name="manualCandidateInput"
                    aria-label="手动候选名单"
                    placeholder="每行一位用户，支持 CSV、TSV、JSON；也可以选择文件导入。"
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
                    <span className="sr-only">官方访问令牌</span>
                    <input
                      value={c.accessToken}
                      onChange={(event) => c.setAccessToken(event.target.value)}
                      name="accessToken"
                      type="password"
                      placeholder="输入官方访问令牌"
                    />
                  </label>
                  <button className="v3-solid-action v3-primary-action" type="button" onClick={() => c.safeLoadCandidates({ jumpAfterLoad: false })} disabled={c.isLoading}>
                    {I.download}
                    通过官方接口载入
                  </button>
                </div>
              )}
            </section>

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
                  />
                  <button type="button" onClick={() => c.setShowFilters(true)} aria-label="筛选候选">{I.listChecks}</button>
                </div>
                <div className="segmented-control">
                  <button type="button" className={c.candidateSegment === 'eligible' ? 'is-active' : ''} onClick={() => c.setCandidateSegment('eligible')}>可抽 {c.eligible.length}</button>
                  <button type="button" className={c.candidateSegment === 'all' ? 'is-active' : ''} onClick={() => c.setCandidateSegment('all')}>全部 {c.candidates.length}</button>
                  <button type="button" className={c.candidateSegment === 'excluded' ? 'is-active' : ''} onClick={() => c.setCandidateSegment('excluded')}>已排除 {excludedCandidates.length}</button>
                </div>
              </>
            )}

            <section className="content-section candidate-section">
              <SectionTitle
                eyebrow={c.hasCandidates ? '按载入顺序' : '尚未载入'}
                title="候选用户"
                action={c.hasCandidates ? '导出' : ''}
                onAction={() => download('eligible-candidates.csv', toCsv(c.eligible.map((item) => ({ tier: '', ...item }))))}
              />
              {visibleCandidates.length ? (
                <div className="people-list">
                  {visibleCandidates.map((candidate, index) => (
                    <button
                      type="button"
                      key={candidate.id || candidate.uid || candidate.screenName || index}
                      onClick={() => c.showStatus(candidate.text || candidate.uid || '候选用户', 'neutral', {
                        popup: true,
                        title: candidate.screenName || candidate.uid || `候选用户 ${index + 1}`,
                      })}
                    >
                      <CandidateAvatar candidate={candidate} className="candidate-avatar-list" apiBase={c.apiBase} />
                      <span>
                        <strong>{candidate.screenName || candidate.uid || `候选用户 ${index + 1}`}</strong>
                        <small>{candidate.uid ? `UID ${candidate.uid}` : friendlyProviderText(candidate.source) || '候选名单'}</small>
                      </span>
                      <span className={eligibleIds.has(identityOf(candidate)) ? 'status-badge' : 'status-badge is-excluded'}>
                        {eligibleIds.has(identityOf(candidate)) ? '符合' : '排除'}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="v3-section-empty v3-candidate-empty">
                  <span>{I.users}</span>
                  <div><strong>{c.hasCandidates ? '没有匹配的候选用户' : '候选名单为空'}</strong><small>{c.hasCandidates ? '调整搜索或筛选条件后再查看' : '载入名单后，候选用户会显示在这里'}</small></div>
                </div>
              )}
            </section>
            <div className="bottom-space" />
          </div>
        </section>

        <section className={`root-view ${c.activeTab === 'history' ? 'is-active' : ''}`} data-root-view="history" hidden={c.activeTab !== 'history'}>
          <div className="root-scroll">
            <header className="large-title">
              <span className="title-status neutral"><i /> 已保存的开奖结果</span>
              <h1>开奖记录</h1>
              <p>{c.drawHistory.length ? `共 ${c.drawHistory.length} 次开奖，${totalHistoricWinners} 名获奖用户` : '完成开奖后，记录会自动保存在这里'}</p>
            </header>

            <section className="history-summary">
              <div><span>总开奖</span><strong>{c.drawHistory.length}</strong><small>次</small></div>
              <div><span>获奖用户</span><strong>{totalHistoricWinners}</strong><small>人</small></div>
              <div><span>最近开奖</span><strong>{c.drawHistory[0]?.time?.slice(5, 10).replace('-', '.') || '--'}</strong><small>{c.drawHistory[0]?.time?.slice(11, 16) || '暂无'}</small></div>
            </section>

            <section className="content-section">
              <SectionTitle eyebrow="最近在前" title="全部记录" />
              {visibleHistory.length ? (
                <>
                  <div className="history-list">
                    {visibleHistory.map((item, index) => {
                      const date = String(item.time || '').slice(5, 10).split('-');
                      return (
                        <button
                          type="button"
                          key={`${item.time}-${index}`}
                          onClick={() => c.setSelectedReceipt(item)}
                        >
                          <span className={`date-block ${index % 3 === 1 ? 'blue' : index % 3 === 2 ? 'mint' : ''}`}>
                            <strong>{date[1] || '--'}</strong><small>{date[0] || '--'} 月</small>
                          </span>
                          <span><strong>{item.results?.[0]?.prize?.name || '微博转发抽奖'}</strong><small>{item.results?.length || 1} 个奖项 · {item.total} 名获奖用户</small></span>
                          {I.chevron}
                        </button>
                      );
                    })}
                  </div>
                  {c.drawHistory.length > 3 && (
                    <button className="show-more-button" type="button" onClick={() => c.setHistoryExpanded((value) => !value)}>
                      {c.historyExpanded ? '收起较早记录' : `展开全部 ${c.drawHistory.length} 条`}
                    </button>
                  )}
                </>
              ) : (
                <div className="v3-section-empty v3-history-empty">
                  <span>{I.clock}</span>
                  <div><strong>暂无开奖记录</strong><small>完成一次抽奖后再来查看</small></div>
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
              <p>开奖记录、连接设置与使用说明</p>
            </header>

            <button className="app-summary" type="button" onClick={() => c.openLegalDocument('about')}>
              <img src={publicAsset('avatar.jpg')} alt="" />
              <span><strong>微博转发抽奖</strong><small>版本 {APP_VERSION} · by.sameko</small></span>
              <em>关于</em>
              {I.chevron}
            </button>

            <section className="content-section">
              <SectionTitle eyebrow="当前状态" title="数据与连接" />
              <div className="grouped-list">
                <AppListRow icon={I.clock} tone="coral" title="本机记录" detail="保存在当前浏览器的开奖记录" value={`${c.drawHistory.length} 条`} onClick={() => c.setShowSettings(true)} />
                <AppListRow icon={I.shield} title="微博 Cookie" detail="本次填写优先，未填写时使用服务器" value={c.accountStatusText} onClick={() => c.setShowSettings(true)} />
                <AppListRow icon={I.refresh} tone="mint" title="后端连接" detail="候选载入、开奖记录与头像服务" value={c.serviceStatusText} onClick={c.testApiConnection} />
              </div>
            </section>

            <section className="content-section">
              <SectionTitle eyebrow="应用" title="偏好与帮助" />
              <div className="grouped-list">
                <AppListRow icon={I.settings} tone="gray" title="数据设置" detail="清理本机数据或修改后端地址" onClick={() => c.setShowSettings(true)} />
                <AppListRow icon={I.book} tone="coral" title="使用教程" detail="从候选载入到保存结果" onClick={() => c.setShowGuide(true)} />
                <AppListRow icon={I.feedback} tone="mint" title="意见反馈" detail="提交建议或报告使用问题" onClick={() => c.setShowFeedback(true)} />
                <AppListRow icon={I.info} tone="lilac" title="关于此应用" detail="用途、版本与服务关系" onClick={() => c.openLegalDocument('about')} />
              </div>
            </section>

            <section className="content-section">
              <SectionTitle eyebrow="文档" title="法律与许可" />
              <div className="grouped-list">
                <AppListRow icon={I.alert} tone="coral" title="免责声明" detail="服务边界与使用责任" onClick={() => c.openLegalDocument('disclaimer')} />
                <AppListRow icon={I.shield} title="隐私政策" detail="Cookie、候选与记录如何处理" onClick={() => c.openLegalDocument('privacy')} />
                <AppListRow icon={I.file} tone="mint" title="用户协议" detail="使用规则与禁止事项" onClick={() => c.openLegalDocument('terms')} />
                <AppListRow icon={I.info} tone="lilac" title="版权说明" detail="应用、用户与平台内容" onClick={() => c.openLegalDocument('copyright')} />
                <AppListRow icon={I.file} tone="gray" title="开源许可" detail="第三方软件与许可证" onClick={() => c.openLegalDocument('licenses')} />
              </div>
            </section>
            <div className="bottom-space" />
          </div>
        </section>
      </main>

      <nav className="root-tabbar glass" aria-label="主要导航" style={{ '--tab-index': tabIndex }}>
        <span className="tab-highlight" />
        <button className={c.activeTab === 'home' ? 'is-active' : ''} type="button" onClick={() => switchTab('home')}>
          {I.sparkles}<span>抽奖</span>
        </button>
        <button className={c.activeTab === 'candidates' ? 'is-active' : ''} type="button" onClick={() => switchTab('candidates')}>
          {I.users}<span>名单</span>
        </button>
        <button className={c.activeTab === 'history' ? 'is-active' : ''} type="button" onClick={() => switchTab('history')}>
          {I.clock}<span>记录</span>
        </button>
        <button className={c.activeTab === 'more' ? 'is-active' : ''} type="button" onClick={() => switchTab('more')}>
          {I.more}<span>更多</span>
        </button>
      </nav>

      {c.showGuide && <GuideSheet onClose={() => c.setShowGuide(false)} />}
      {c.showFeedback && <FeedbackSheet onClose={() => c.setShowFeedback(false)} onSubmit={c.submitFeedback} />}
      {c.legalDocument && <LegalSheet document={c.legalDocument} onClose={() => c.setLegalDocument(null)} onOpenUpdates={() => c.openLegalDocument('updates')} />}

      {c.showSourceEditor && (
        <SheetFrame title="候选来源" subtitle={sourceDetail} icon={I.link} onClose={() => c.setShowSourceEditor(false)} className="v3-editor-sheet v3-source-sheet">
          <div className="segmented-control v3-source-control">
            {SOURCE_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={c.source === value ? 'is-active' : ''}
                onClick={() => {
                  c.setSource(value);
                  c.clearResult();
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
                <div><strong>微博链接载入</strong><small>粘贴正文链接后读取公开可见的转发</small></div>
              </div>
              <label className="v3-link-field">
                <span className="sr-only">微博链接、mid 或 bid</span>
                <input
                  ref={c.statusInputRef}
                  value={c.statusUrl}
                  onChange={(event) => {
                    c.setStatusUrl(event.target.value);
                    c.setCurrentStatusUrl(event.target.value);
                  }}
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
                <span><strong>{c.accountStatusText}</strong><small>留空时使用服务器登录态</small></span>
                <button type="button" onClick={() => c.loadCookieStatus(true)}>校验</button>
              </div>
              <button className="v3-disclosure" type="button" onClick={() => c.setManualCookieOpen((value) => !value)} aria-expanded={c.manualCookieOpen}>
                <span>使用自己的 Cookie（优先）</span>
                <span>{c.manualCookieOpen ? '收起' : '展开'} {I.chevron}</span>
              </button>
              {c.manualCookieOpen && (
                <textarea
                  className="v3-textarea"
                  value={c.mobileCookie}
                  onChange={(event) => c.setMobileCookie(event.target.value)}
                  name="sourceSheetMobileCookie"
                  aria-label="用户微博 Cookie"
                  placeholder="仅用于本次载入任务；留空时使用服务器登录态。"
                />
              )}
            </div>
          )}

          {c.source === 'manual' && (
            <div className="v3-source-form v3-sheet-source-form">
              <div className="v3-sheet-callout">
                <span className="row-icon coral">{I.users}</span>
                <div><strong>手动名单</strong><small>直接填写，也可以导入 CSV、TSV 或 JSON</small></div>
              </div>
              <textarea
                className="v3-textarea v3-list-input"
                value={c.manualInput}
                onChange={(event) => c.setManualInput(event.target.value)}
                name="sourceSheetManualCandidates"
                aria-label="弹窗手动候选名单"
                placeholder="每行一位用户，支持 CSV、TSV、JSON。"
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
                <span className="sr-only">官方访问令牌</span>
                <input
                  value={c.accessToken}
                  onChange={(event) => c.setAccessToken(event.target.value)}
                  name="sourceSheetAccessToken"
                  type="password"
                  placeholder="输入官方访问令牌"
                />
              </label>
              <button className="v3-pearl-action v3-primary-action" type="button" onClick={() => c.safeLoadCandidates({ jumpAfterLoad: false })} disabled={c.isLoading}>
                <span className="v3-pearl-icon">{c.isLoading ? I.refresh : I.download}</span>
                <span className="v3-pearl-copy"><strong>{c.isLoading ? '正在载入候选' : '通过官方接口载入'}</strong><small>令牌仅用于当前页面请求</small></span>
                <span className="v3-pearl-arrow">{I.chevron}</span>
              </button>
            </div>
          )}

          <button type="button" className="flow-sheet-primary v3-primary-action" onClick={() => c.setShowSourceEditor(false)}>完成</button>
        </SheetFrame>
      )}

      {c.showPrizeEditor && (
        <SheetFrame title="奖项设置" subtitle={`${c.normalizedPrizes.length} 个奖项 · ${c.totalSlots} 个名额`} icon={I.gift} onClose={() => c.setShowPrizeEditor(false)} className="v3-editor-sheet">
          <div className="v3-sheet-toolbar">
            <span>按顺序依次抽取</span>
            <button type="button" onClick={c.addPrize}>{I.plus} 添加奖项</button>
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
                      <input type="number" min="1" value={prize.count} onChange={(event) => c.updatePrizeCount(index, event.target.value)} aria-label={`第 ${index + 1} 个奖项中奖人数`} />
                      <button
                        type="button"
                        aria-label={`增加第 ${index + 1} 个奖项名额`}
                        onClick={() => c.updatePrizeCount(index, Number(prize.count || 1) + 1)}
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
          <button type="button" className="flow-sheet-primary v3-primary-action" onClick={() => c.setShowPrizeEditor(false)}>完成</button>
        </SheetFrame>
      )}

      {c.showFilters && (
        <SheetFrame title="筛选规则" subtitle="调整本轮可抽候选" icon={I.listChecks} onClose={() => c.setShowFilters(false)} className="v3-editor-sheet">
          <div className="v3-filter-presets">
            <button
              type="button"
              className={!c.keyword && Number(c.mentionMin) === 0 ? 'is-active' : ''}
              aria-pressed={!c.keyword && Number(c.mentionMin) === 0}
              onClick={() => { c.setKeyword(''); c.setMentionMin(0); c.clearResult('筛选规则已更新，请重新开奖。'); }}
            >
              不限内容
            </button>
            <button
              type="button"
              className={c.keyword === '抽奖' && Number(c.mentionMin) === 0 ? 'is-active' : ''}
              aria-pressed={c.keyword === '抽奖' && Number(c.mentionMin) === 0}
              onClick={() => { c.setKeyword('抽奖'); c.setMentionMin(0); c.clearResult('筛选规则已更新，请重新开奖。'); }}
            >
              含“抽奖”
            </button>
            <button
              type="button"
              className={!c.keyword && Number(c.mentionMin) === 1 ? 'is-active' : ''}
              aria-pressed={!c.keyword && Number(c.mentionMin) === 1}
              onClick={() => { c.setKeyword(''); c.setMentionMin(1); c.clearResult('筛选规则已更新，请重新开奖。'); }}
            >
              至少 @1
            </button>
            <button
              type="button"
              className={!c.keyword && Number(c.mentionMin) === 2 ? 'is-active' : ''}
              aria-pressed={!c.keyword && Number(c.mentionMin) === 2}
              onClick={() => { c.setKeyword(''); c.setMentionMin(2); c.clearResult('筛选规则已更新，请重新开奖。'); }}
            >
              至少 @2
            </button>
          </div>
          <div className="v3-form-group">
            <label><span>转发关键词</span><input value={c.keyword} onChange={(event) => { c.setKeyword(event.target.value); c.clearResult('筛选规则已更新，请重新开奖。'); }} placeholder="留空表示不限" /></label>
            <label><span>至少 @ 人数</span><input type="number" min="0" max="10" value={c.mentionMin} onChange={(event) => { c.setMentionMin(event.target.value); c.clearResult('筛选规则已更新，请重新开奖。'); }} /></label>
            <label><span>排除名单</span><textarea value={c.blocklist} onChange={(event) => { c.setBlocklist(event.target.value); c.clearResult('筛选规则已更新，请重新开奖。'); }} placeholder="每行一个 UID 或昵称" /></label>
          </div>
          <div className="v3-toggle-list">
            <label><span><strong>候选去重</strong><small>同一用户只保留一次</small></span><input type="checkbox" checked={c.uniqueByUser} onChange={(event) => c.setUniqueByUser(event.target.checked)} /></label>
             <label><span><strong>排除已中奖用户</strong><small>仅限当前浏览器的当前任务</small></span><input type="checkbox" checked={c.excludePrevious} onChange={(event) => c.setExcludePrevious(event.target.checked)} /></label>
          </div>
          <button type="button" className="flow-sheet-primary v3-primary-action" onClick={() => c.setShowFilters(false)}>应用筛选</button>
        </SheetFrame>
      )}

      {c.showSettings && (
        <SheetFrame title="设置" subtitle="显示、数据与后端连接" icon={I.settings} onClose={() => c.setShowSettings(false)} className="v3-editor-sheet">
          <div className="flow-app-summary">
            <img src={publicAsset('avatar.jpg')} alt="" />
            <div><strong>微博转发抽奖</strong><p>版本 {APP_VERSION} · by.sameko</p></div>
            <span>{c.accountStatusText}</span>
          </div>
          <h3 className="flow-settings-caption">显示</h3>
          <div className="flow-motion-setting">
            <div className="flow-motion-heading">
              <span>{I.sparkles}</span>
              <div>
                <strong>界面动效</strong>
                <small>{c.motionPreference === 'full' ? '播放完整页面、弹窗与开奖动效' : c.motionPreference === 'reduced' ? '保留状态反馈，减少大幅位移' : '遵循设备的动态效果设置'}</small>
              </div>
            </div>
            <div className="segmented-control motion-segmented" role="group" aria-label="开奖动效强度">
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
          <h3 className="flow-settings-caption">当前设备</h3>
          <div className="flow-settings-list">
            <button type="button" onClick={() => { c.setCandidates([]); c.setResults([]); c.setLastPool(null); c.setShowSettings(false); c.showStatus('已清空候选和结果。', 'success', { popup: true, title: '已清空' }); }}>
              <span>{I.trash}</span><div><strong>清空当前抽奖</strong><small>移除当前候选与结果，不影响服务器记录</small></div>{I.chevron}
            </button>
            <button type="button" onClick={() => { c.setMobileCookie(''); c.showStatus('已清空当前输入的 Cookie。', 'success', { popup: true, title: '已清空' }); }}>
              <span>{I.shield}</span><div><strong>清除本次 Cookie</strong><small>不会修改服务器 Cookie</small></div>{I.chevron}
            </button>
            <button type="button" onClick={() => { c.setDrawHistory([]); c.showStatus('已清空本机开奖记录。', 'success', { popup: true, title: '已清空' }); }}>
              <span>{I.clock}</span><div><strong>清空本机记录</strong><small>仅移除当前浏览器中的开奖记录</small></div>{I.chevron}
            </button>
          </div>
          <details className="flow-connection-details">
            <summary>后端连接</summary>
            <div className="flow-settings-form">
              <label className="flow-field-block"><span>后端接口地址</span><input value={c.apiBase} onChange={(event) => c.setApiBase(cleanApiBase(event.target.value))} placeholder="https://111.228.11.206" /></label>
              <label className="flow-field-block"><span>访问密钥（可选）</span><input value={c.apiKey} onChange={(event) => c.setApiKey(event.target.value)} type="password" placeholder="公开模式不用填写" /></label>
              <div className="flow-settings-actions">
                <button type="button" onClick={c.testApiConnection}>测试连接</button>
                <button type="button" onClick={() => { c.setApiBase(''); c.setApiKey(''); c.showStatus('已改用当前站点的后端。', 'success', { popup: true, title: '已切换' }); }}>使用当前站点</button>
              </div>
            </div>
          </details>
          <button type="button" className="flow-sheet-primary v3-primary-action" onClick={() => c.setShowSettings(false)}>完成</button>
        </SheetFrame>
      )}

      <DrawResultSheet
        receipt={c.selectedReceipt}
        apiBase={c.apiBase}
        isCapturing={c.isCapturing}
        onClose={() => c.setSelectedReceipt(null)}
        onSaveImage={() => c.createShareImage(c.selectedReceipt)}
        onCopyPost={() => c.copyReceiptPost(c.selectedReceipt)}
        onCopyFairness={() => c.copyReceiptFairness(c.selectedReceipt)}
        onRetrySave={() => c.retrySaveReceipt(c.selectedReceipt)}
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
  const [lastPool, setLastPool] = useState(null);
  const [lastAudit, setLastAudit] = useState(null);
  const [sourceMeta, setSourceMeta] = useState(null);
  const [currentStatusId, setCurrentStatusId] = useState('');
  const [currentStatusUrl, setCurrentStatusUrl] = useState('');
  const [drawCount, setDrawCount] = useState(null);
  const [cookieInfo, setCookieInfo] = useState({ hasCookie: false, cookieCount: 0, lastValidAt: '' });
  const [status, setStatus] = useState('等待载入候选。');
  const [statusTone, setStatusTone] = useState('neutral');
  const [progress, setProgress] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [rollingCandidate, setRollingCandidate] = useState(null);
  const [phase, setPhase] = useState('');
  const [drawHistory, setDrawHistory] = useState(() => readDrawHistory());
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [pendingReceipt, setPendingReceipt] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [legalDocument, setLegalDocument] = useState(null);
  const [notice, setNotice] = useState(null);
  const [activeTab, setActiveTab] = useState('home');
  const [showSourceEditor, setShowSourceEditor] = useState(false);
  const [showPrizeEditor, setShowPrizeEditor] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [candidateSegment, setCandidateSegment] = useState('eligible');
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [manualCookieOpen, setManualCookieOpen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [motionPreference, setMotionPreference] = useState(initialMotionPreference);
  const [apiBase, setApiBase] = useState(initialApiBase);
  const [apiKey, setApiKey] = useState('');
  const [apiHealth, setApiHealth] = useState('checking');
  const firstPrizeNameRef = useRef(null);
  const statusInputRef = useRef(null);

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
    return { keyword: keyword.trim().toLowerCase(), mentionMin: Math.max(0, Number(mentionMin || 0)), uniqueByUser, excludePrevious, blocked };
  }, [keyword, mentionMin, uniqueByUser, excludePrevious, blocklist]);

  function filterEligibleCandidates(sourceCandidates, activeRules = rules, activeHistoryUids = historyUids) {
    const seen = new Set();
    const list = [];
    for (const candidate of sourceCandidates) {
      const identity = String(candidate.uid || candidate.screenName || candidate.id || '').toLowerCase();
      const name = String(candidate.screenName || '').toLowerCase();
      if (activeRules.uniqueByUser && identity) {
        if (seen.has(identity)) continue;
        seen.add(identity);
      }
      if (activeRules.excludePrevious && identity && activeHistoryUids.has(identity)) continue;
      if (activeRules.blocked.has(identity) || activeRules.blocked.has(name)) continue;
      if (activeRules.keyword && !String(candidate.text || '').toLowerCase().includes(activeRules.keyword)) continue;
      const mentionCount = (String(candidate.text || '').match(/@[\p{L}\p{N}_\-\u4e00-\u9fa5]+/gu) || []).length;
      if (activeRules.mentionMin && mentionCount < activeRules.mentionMin) continue;
      list.push(candidate);
    }
    return list;
  }

  const eligible = useMemo(
    () => filterEligibleCandidates(candidates),
    [candidates, rules, historyUids],
  );

  const displayPool = lastPool || eligible;
  const winners = results.flatMap((item) => item.winners);

  function apiPath(path) {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return apiBase ? `${apiBase}${cleanPath}` : cleanPath;
  }
  function apiFetch(path, options = {}) {
    if (!apiBase && isStaticHostedPage()) {
      return Promise.reject(new Error('当前是静态前端，请先在设置里确认后端接口地址。'));
    }
    if (apiBase && !isTrustedApiBase(apiBase)) {
      return Promise.reject(new Error('后端接口地址不在可信列表里，请使用当前公开后端或本地地址。'));
    }
    const headers = new Headers(options.headers || {});
    if (apiKey.trim()) headers.set('x-api-key', apiKey.trim());
    return fetch(apiPath(path), { ...options, headers });
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
  function openLegalDocument(key) {
    setShowSettings(false);
    setLegalDocument(LEGAL_DOCUMENTS[key] || null);
  }
  async function submitFeedback(payload) {
    try {
      const response = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(normalizeFeedbackSubmission(payload)),
      });
      const data = await response.json().catch(() => ({}));
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
  function selectCandidateSource(value) {
    setSource(value);
    clearResult();
    setShowSourceEditor(true);
  }
  function safeLoadCandidates(options) {
    loadCandidates(options).catch(() => {});
  }
  async function pasteAndLoadCandidates() {
    if (isLoading || isDrawing) return;
    const existingValue = statusUrl.trim();
    if (existingValue) {
      setSource('mobile');
      safeLoadCandidates({
        jumpAfterLoad: false,
        sourceOverride: 'mobile',
        statusUrlOverride: existingValue,
      });
      return;
    }
    try {
      if (!navigator.clipboard?.readText) throw new Error('clipboard-unavailable');
      const pastedValue = (await navigator.clipboard.readText()).trim();
      if (!pastedValue) throw new Error('clipboard-empty');
      setStatusUrl(pastedValue);
      setCurrentStatusUrl(pastedValue);
      setSource('mobile');
      safeLoadCandidates({
        jumpAfterLoad: false,
        sourceOverride: 'mobile',
        statusUrlOverride: pastedValue,
      });
    } catch {
      statusInputRef.current?.focus();
      showStatus('请在输入框中粘贴微博正文链接、mid 或 bid。', 'neutral', {
        popup: true,
        title: '粘贴微博链接',
      });
    }
  }
  function handleStatusPaste(event) {
    const pastedValue = event.clipboardData?.getData('text')?.trim();
    if (!pastedValue || isLoading || isDrawing) return;
    event.preventDefault();
    setStatusUrl(pastedValue);
    setCurrentStatusUrl(pastedValue);
    setSource('mobile');
    safeLoadCandidates({
      jumpAfterLoad: false,
      sourceOverride: 'mobile',
      statusUrlOverride: pastedValue,
    });
  }
  function clearResult(message) {
    if (message && results.length) showStatus(message);
    setResults([]);
    setLastPool(null);
    setLastAudit(null);
    setSelectedReceipt(null);
  }
  function jumpToPrizeSettings() {
    setShowPrizeEditor(true);
    requestAnimationFrame(() => {
      window.setTimeout(() => firstPrizeNameRef.current?.focus(), 380);
    });
  }
  function ensurePrizeSettingsReady() {
    if (!normalizedPrizes.length || totalSlots < 1) {
      showStatus('请先填写至少一个奖项名称和中奖人数。', 'error');
      jumpToPrizeSettings();
      return false;
    }
    return true;
  }
  function updatePrize(index, patch) {
    setPrizes((previous) => previous.map((prize, prizeIndex) => (
      prizeIndex === index ? { ...prize, ...patch } : prize
    )));
    clearResult('奖项已更新，请重新开奖。');
  }
  function updatePrizeCount(index, nextCount) {
    updatePrize(index, { count: Math.max(1, parseInt(nextCount, 10) || 1) });
  }
  function addPrize() {
    setPrizes((previous) => [...previous, defaultPrize(previous.length, 1)]);
    clearResult('奖项已更新，请重新开奖。');
  }
  function removePrize(index) {
    if (prizes.length <= 1) {
      showStatus('至少保留一个奖项。', 'error');
      return;
    }
    setPrizes((previous) => previous.filter((_, prizeIndex) => prizeIndex !== index));
    clearResult('奖项已更新，请重新开奖。');
  }

  async function loadCookieStatus(check = false) {
    try {
      const response = await apiFetch(`/api/weibo/cookie-status${check ? '?check=1' : ''}`);
      const json = await response.json();
      if (!json.ok) throw new Error(json.error || '服务器 Cookie 状态读取失败');
      setCookieInfo(json);
      setApiHealth('ok');
      if (check) {
        const accountCount = Number(json.accountCount ?? json.cookieCount ?? 0);
        if (json.checkSkipped) {
          showStatus('服务器 Cookie 状态受站长密钥保护，普通访客只能查看可用数量。');
        } else {
          showStatus(json.hasCookie
            ? `服务器 Cookie 池有 ${accountCount || 1} 项通过校验，失效项会自动移除。`
            : '服务器端暂无可用 Cookie，可以展开并填写自己的 Cookie。');
        }
      }
    } catch (error) {
      setApiHealth('error');
      if (check && !/Unexpected token|not valid JSON/i.test(error.message || '')) showStatus(error.message, 'error');
    }
  }

  async function testApiConnection() {
    try {
      const response = await apiFetch('/api/health');
      const json = await response.json();
      if (!json.ok) throw new Error(json.error || '后端没有返回 ok');
      setApiHealth('ok');
      showStatus(`后端连接成功：${apiBase || location.origin}`, 'success');
    } catch (error) {
      setApiHealth('error');
      showStatus(`后端连接失败：${error.message}`, 'error');
    }
  }

  async function refreshDrawCount(value = statusUrl) {
    if (source === 'manual' || !value.trim()) {
      setDrawCount(null);
      return;
    }
    try {
      const response = await apiFetch(`/api/weibo/draw-count?statusUrl=${encodeURIComponent(value)}`);
      const json = await response.json();
      if (!json.ok) throw new Error(json.error || '抽奖次数查询失败');
      setCurrentStatusId(json.statusId || '');
      setCurrentStatusUrl(json.statusUrl || value);
      setDrawCount(json.drawCount);
    } catch {
      setDrawCount(null);
    }
  }

  useEffect(() => {
    setApiHealth('checking');
    loadCookieStatus(false);
  }, [apiBase]);
  useEffect(() => {
    const cleaned = cleanApiBase(apiBase);
    writeStoredValue('weibo-draw-api-base', cleaned && isTrustedApiBase(cleaned) ? cleaned : '');
  }, [apiBase]);
  useEffect(() => {
    writeStoredValue('weibo-draw-motion', motionPreference);
  }, [motionPreference]);
  useEffect(() => {
    try {
      writeDrawHistory(window.localStorage, drawHistory);
    } catch {
      setStatus('本机存储不可用，刷新后不会保留开奖记录。');
      setStatusTone('neutral');
    }
  }, [drawHistory]);
  useEffect(() => {
    const timer = setTimeout(() => refreshDrawCount(statusUrl), 420);
    return () => clearTimeout(timer);
  }, [statusUrl, source, apiBase]);
  useEffect(() => {
    if (!pendingReceipt || isDrawing) return undefined;
    const reducedMotion = shouldReduceMotion(motionPreference);
    const timer = window.setTimeout(() => {
      setSelectedReceipt(pendingReceipt);
      setPendingReceipt(null);
    }, reducedMotion ? 420 : 1040);
    return () => window.clearTimeout(timer);
  }, [pendingReceipt, isDrawing, motionPreference]);

  async function fetchRepostsWithProgress(payload) {
    setProgress({ percent: 3, message: '创建抓取任务' });
    const startResponse = await apiFetch('/api/weibo/reposts/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const started = await startResponse.json();
    if (!started.ok) throw new Error(started.error || '抓取任务创建失败');
    let lastProgress = started.progress || { percent: 3, message: '任务已创建' };
    const deadline = Date.now() + REPOST_JOB_TIMEOUT_MS;
    setProgress(lastProgress);
    while (true) {
      if (Date.now() > deadline) throw new Error('抓取任务等待时间过长，请稍后重试。');
      await sleep(REPOST_JOB_POLL_MS);
      const response = await apiFetch(`/api/weibo/reposts/jobs/${encodeURIComponent(started.jobId)}`);
      const json = await response.json();
      if (!json.ok) throw new Error(json.error || '抓取进度读取失败');
      lastProgress = json.progress || lastProgress;
      setProgress(lastProgress);
      if (json.status === 'done') return json.result;
      if (json.status === 'error') throw new Error(json.error || lastProgress.message || '抓取失败');
    }
  }

  async function loadCandidates(options = {}) {
    const {
      jumpAfterLoad = true,
      sourceOverride = source,
      statusUrlOverride = statusUrl,
    } = options;
    const effectiveSource = sourceOverride;
    const effectiveStatusUrl = String(statusUrlOverride || '').trim();
    setIsLoading(true);
    clearResult();
    try {
      if (effectiveSource === 'manual') {
        const parsed = parseManualInput(manualInput);
        if (!parsed.length) throw new Error('请先粘贴或导入候选名单。');
        const freshHistory = new Set();
        setCandidates(parsed);
        setCurrentStatusId('');
        setCurrentStatusUrl('');
        setDrawCount(null);
        setSourceMeta({ provider: 'manual' });
        setHistoryUids(freshHistory);
        showStatus(`已导入 ${parsed.length} 位候选用户，请确认奖项设置。`, 'success');
        if (jumpAfterLoad) jumpToPrizeSettings();
        return {
          candidates: parsed,
          eligible: filterEligibleCandidates(parsed, rules, freshHistory),
          statusId: '',
          statusUrl: '',
          sourceMeta: { provider: 'manual' },
        };
      }
      if (!effectiveStatusUrl) throw new Error('请先粘贴微博正文链接、mid 或 bid。');
      if (effectiveSource === 'official' && !accessToken.trim()) throw new Error('请先填写微博官方访问令牌。');
      setStatusUrl(effectiveStatusUrl);
      setCurrentStatusUrl(effectiveStatusUrl);
      showStatus(effectiveSource === 'mobile'
        ? '正在读取微博公开可见的转发；未填写 Cookie 时使用服务器登录态。'
        : '正在通过微博官方接口读取公开可见的转发。');
      const json = await fetchRepostsWithProgress({
        source: effectiveSource,
        statusUrl: effectiveStatusUrl,
        accessToken,
        mobileCookie: effectiveSource === 'mobile' ? mobileCookie : '',
      });
      if (!json.ok) throw new Error(json.error || '微博数据拉取失败');
      const loadedCandidates = json.candidates || [];
      const loadedStatusId = json.statusId || '';
      const freshHistory = winnerIdsForStatus(drawHistory, loadedStatusId);
      setCandidates(loadedCandidates);
      setCurrentStatusId(loadedStatusId);
      setCurrentStatusUrl(json.statusUrl || effectiveStatusUrl);
      setDrawCount(json.drawCount ?? 0);
      setSourceMeta({ ...(json.meta || {}), statusId: json.statusId, statusUrl: json.statusUrl });
      setHistoryUids(freshHistory);
      if (effectiveSource === 'mobile') await loadCookieStatus(false);
      const pageCount = Array.isArray(json.meta?.pages) ? json.meta.pages.length : 0;
      const totalNumber = Number(json.meta?.totalNumber);
      const totalText = Number.isFinite(totalNumber) ? `接口显示总转发约 ${totalNumber} 条。` : '';
      showStatus(`已载入 ${json.candidates?.length || 0} 条可见转发，扫描 ${pageCount} 页。${totalText ? `${totalText} ` : ''}请确认奖项后开奖。`, 'success');
      if (jumpAfterLoad) jumpToPrizeSettings();
      return {
        candidates: loadedCandidates,
        eligible: filterEligibleCandidates(loadedCandidates, rules, freshHistory),
        statusId: json.statusId || '',
        statusUrl: json.statusUrl || effectiveStatusUrl,
        sourceMeta: { ...(json.meta || {}), statusId: json.statusId, statusUrl: json.statusUrl },
      };
    } catch (error) {
      showStatus(error.message, 'error');
      throw error;
    } finally {
      setIsLoading(false);
      setTimeout(() => setProgress(null), 1200);
    }
  }

  async function drawAll() {
    if (isDrawing || isLoading || pendingReceipt) return;
    if (!ensurePrizeSettingsReady()) return;
    let drawCandidates = candidates;
    let drawEligible = eligible;
    let drawContext = { statusId: currentStatusId, statusUrl: currentStatusUrl, sourceMeta };

    if (!drawEligible.length) {
      showStatus('正在先载入候选名单。');
      try {
        const loaded = await loadCandidates({ jumpAfterLoad: false });
        drawCandidates = loaded?.candidates || [];
        drawEligible = loaded?.eligible || [];
        drawContext = {
          statusId: loaded?.statusId || currentStatusId,
          statusUrl: loaded?.statusUrl || currentStatusUrl || statusUrl.trim(),
          sourceMeta: loaded?.sourceMeta || sourceMeta,
        };
      } catch {
        return;
      }
    }

    if (!drawEligible.length) {
      showStatus('没有可抽候选，请检查链接、Cookie 或筛选规则。', 'error');
      return;
    }
    if (totalSlots > drawEligible.length) {
      showStatus(`中奖总人数 ${totalSlots} 不能超过可抽人数 ${drawEligible.length}。`, 'error');
      return;
    }
    setIsDrawing(true);
    setResults([]);
    setRollingCandidate(null);
    try {
      const reducedMotion = shouldReduceMotion(motionPreference);
      const seed = randomSeedHex();
      const candidateDigest = await digestCandidates(drawEligible);
      const pool = await seededShuffle(drawEligible, `${seed}:${candidateDigest}`);
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
            const index = pool.length ? (prizeIndex * 19 + tick * 7 + Math.floor(tick / 3)) % pool.length : 0;
            setRollingCandidate(pool[index] || null);
            await sleep(Math.min(96, 46 + tick * 4));
            tick += 1;
          }
        }
        setRollingCandidate(prizeWinners.at(-1) || null);
        setPhase(`${prize.name} 开奖完成`);
        if (!reducedMotion) await sleep(360);
        all.push({ prize, winners: prizeWinners });
        setResults([...all]);
        if (prizeIndex < normalizedPrizes.length - 1 && !reducedMotion) await sleep(260);
      }
      const wonIds = new Set(historyUids);
      all.flatMap((item) => item.winners).forEach((winner) => {
        const identity = String(winner.uid || winner.screenName || winner.id || '').toLowerCase();
        if (identity) wonIds.add(identity);
      });
      setHistoryUids(wonIds);
      setLastPool(drawEligible);
      const audit = {
        seed,
        drawnAt: new Date().toISOString(),
        statusId: drawContext.statusId || currentStatusId,
        statusUrl: drawContext.statusUrl || currentStatusUrl,
        rules: { filters: { keyword, mentionMin: Number(mentionMin || 0), uniqueByUser, excludePrevious }, prizes: normalizedPrizes },
        candidateDigest,
        eligibleCount: drawEligible.length,
      };
      setLastAudit(audit);
      const activeSourceMeta = {
        ...(drawContext.sourceMeta || sourceMeta || {}),
        statusId: drawContext.statusId || currentStatusId,
        statusUrl: drawContext.statusUrl || currentStatusUrl || statusUrl.trim(),
      };
      const saved = await saveResult({
        silent: true,
        results: all,
        source,
        statusId: drawContext.statusId || currentStatusId,
        statusUrl: drawContext.statusUrl || currentStatusUrl || statusUrl.trim(),
        sourceMeta: activeSourceMeta,
        totalCount: drawCandidates.length,
        eligibleCount: drawEligible.length,
        audit,
      });
      const manualDrawNumber = source === 'manual' && saved?.file
        ? drawHistory.filter((item) => item.source === 'manual' && item.recordState === 'server').length + 1
        : null;
      const receipt = normalizeDrawReceipt({
        id: saved?.auditHash || `local-${audit.drawnAt}`,
        source,
        statusId: audit.statusId,
        statusUrl: audit.statusUrl,
        drawNumber: saved?.drawNumber ?? manualDrawNumber,
        drawnAt: audit.drawnAt,
        savedAt: saved?.savedAt || '',
        results: all,
        candidateCount: drawCandidates.length,
        eligibleCount: drawEligible.length,
        rules: audit.rules,
        sourceMeta: activeSourceMeta,
        seed: audit.seed,
        candidateDigest: audit.candidateDigest,
        auditHash: saved?.auditHash || '',
        recordState: saved?.file ? 'server' : 'local',
      });
      setDrawHistory((previous) => upsertDrawReceipt(previous, receipt));
      setPendingReceipt(receipt);
      showStatus(
        saved?.file
          ? `已抽出 ${receipt.total} 位中奖用户，结果已保存。`
          : `已抽出 ${receipt.total} 位中奖用户，结果仅保存在本机。`,
        'success',
      );
    } catch (error) {
      showStatus(error.message, 'error');
    } finally {
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
        results: activeResults,
        winners: activeWinners,
        totalCount: opts.totalCount ?? candidates.length,
        eligibleCount: opts.eligibleCount ?? lastAudit?.eligibleCount ?? eligible.length,
        audit: opts.audit ?? lastAudit,
      };
      const response = await apiFetch('/api/draws', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (!json.ok) throw new Error(json.error || '保存失败');
      if (json.statusId) setCurrentStatusId(json.statusId);
      if (json.statusUrl) setCurrentStatusUrl(json.statusUrl);
      if (json.drawCount !== null && json.drawCount !== undefined) setDrawCount(json.drawCount);
      if (!opts.silent) showStatus(`开奖记录已保存：${json.file}`, 'success');
      return json;
    } catch (error) {
      if (!opts.silent) showStatus(error.message, 'error');
      return null;
    }
  }

  async function copyToClipboard(text, successMessage) {
    if (!text.trim()) {
      showStatus('暂无中奖用户可复制。', 'error');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      showStatus(successMessage, 'success');
    } catch (error) {
      showStatus(`复制失败：${error.message}`, 'error');
    }
  }

  function currentReceiptSnapshot() {
    return normalizeDrawReceipt({
      id: lastAudit?.candidateDigest ? `current-${lastAudit.candidateDigest}` : 'current-result',
      source,
      statusId: currentStatusId,
      statusUrl: currentStatusUrl || statusUrl.trim(),
      drawNumber: source === 'manual' ? null : drawCount,
      drawnAt: lastAudit?.drawnAt || '',
      results,
      candidateCount: candidates.length,
      eligibleCount: lastAudit?.eligibleCount ?? eligible.length,
      rules: lastAudit?.rules || null,
      sourceMeta: sourceMeta || {},
      seed: lastAudit?.seed || '',
      candidateDigest: lastAudit?.candidateDigest || '',
      recordState: 'local',
    });
  }

  function resolveReceipt(receiptInput) {
    if (receiptInput?.nativeEvent) return selectedReceipt || currentReceiptSnapshot();
    if (receiptInput) return normalizeDrawReceipt(receiptInput);
    return selectedReceipt || currentReceiptSnapshot();
  }

  function copyReceiptPost(receiptInput) {
    const receipt = resolveReceipt(receiptInput);
    copyToClipboard(
      winnerPostText(receipt.results, receipt.statusUrl),
      '开奖文案已复制。',
    );
  }

  function copyReceiptFairness(receiptInput) {
    copyToClipboard(
      buildFairnessSummary(resolveReceipt(receiptInput)),
      '公平摘要已复制。',
    );
  }

  async function retrySaveReceipt(receiptInput) {
    const receipt = resolveReceipt(receiptInput);
    const saved = await saveResult({
      silent: false,
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
      ? drawHistory.filter((item) => (
        item.id !== receipt.id
        && item.source === 'manual'
        && item.recordState === 'server'
      )).length + 1
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
    setSelectedReceipt(updated);
  }

  async function createShareImage(receiptInput) {
    const receipt = resolveReceipt(receiptInput);
    if (!receipt.results.length) {
      showStatus('请先开奖，再生成开奖记录图。', 'error');
      return;
    }
    try {
      setIsCapturing(true);
      showStatus('正在生成开奖记录图。');
      await sleep(80);
      const providerText = [
        ...(Array.isArray(receipt.sourceMeta?.providers)
          ? receipt.sourceMeta.providers
          : [receipt.sourceMeta?.provider]).filter(Boolean),
        receipt.sourceMeta?.complete === false ? '仅公开可见' : '',
      ].filter(Boolean).join(' / ');
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
        brandAssetUrl: publicAsset('avatar.jpg'),
        avatarProxyBase: apiBase,
      });
      const imageUrl = canvas.toDataURL('image/png');
      const imageName = `weibo-draw-record-${Date.now()}.png`;
      downloadUrl(imageName, imageUrl);
      showStatus('开奖记录图已生成。', 'success');
    } catch (error) {
      showStatus(`开奖记录图生成失败：${error.message}`, 'error');
    } finally {
      setIsCapturing(false);
    }
  }

  function addManualNames() {
    try {
      const parsed = parseManualInput(manualInput);
      if (!parsed.length) throw new Error('请先粘贴或导入候选名单。');
      setCandidates((previous) => {
        const merged = [...previous];
        const seen = new Set(previous.map((item) => item.uid || item.screenName || item.id));
        parsed.forEach((item) => {
          const key = item.uid || item.screenName || item.id;
          if (!seen.has(key)) { seen.add(key); merged.push(item); }
        });
        return merged;
      });
      setManualInput('');
      showStatus(`已添加 ${parsed.length} 位候选用户。`, 'success');
    } catch (error) {
      showStatus(error.message, 'error');
    }
  }
  async function importCandidateFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setSource('manual');
      setManualInput(text);
      showStatus(`已读取 ${file.name}，确认后可导入候选名单。`, 'success', { popup: true, title: '文件已读取' });
    } catch (error) {
      showStatus(`文件读取失败：${error.message}`, 'error');
    } finally {
      event.target.value = '';
    }
  }

  const manualDrawCount = drawHistory.filter((item) => (
    item.source === 'manual' && item.recordState === 'server'
  )).length;
  const activeReceipt = selectedReceipt?.drawnAt === lastAudit?.drawnAt
    ? selectedReceipt
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
      ? drawCountCopy({ source, count: manualDrawCount, completed: false })
      : !statusUrl.trim()
        ? '输入链接后显示'
        : drawCount === null
          ? '正在查询记录'
          : drawCountCopy({ source, count: drawCount, completed: false });
  const hasCandidates = candidates.length > 0;
  const hasResults = results.length > 0;
  const serverAccountCount = Number(cookieInfo.accountCount ?? cookieInfo.cookieCount ?? 0);
  const accountStatusText = mobileCookie.trim()
    ? '使用本次输入'
    : serverAccountCount > 0
      ? `${serverAccountCount} 项可用`
      : '无可用项';
  const serviceStatusText = progress
    ? '任务运行中'
    : apiHealth === 'ok'
      ? '连接正常'
      : apiHealth === 'error'
        ? '连接异常'
        : '正在检查';
  const loadedCandidateCount = displayPool.length || candidates.length;
  const resultTotal = winners.length;
  const filterEnabledText = keyword.trim() || Number(mentionMin || 0) > 0 || blocklist.trim() || excludePrevious ? '已开启' : '默认';
  const filterSummary = buildFilterSummary({
    keyword,
    mentionMin,
    uniqueByUser,
    excludePrevious,
  });
  return (
    <AppleNavigationV3
      controller={{
        source,
        statusUrl,
        accessToken,
        mobileCookie,
        manualInput,
        candidates,
        eligible,
        displayPool,
        prizes,
        normalizedPrizes,
        keyword,
        mentionMin,
        blocklist,
        uniqueByUser,
        excludePrevious,
        results,
        winners,
        drawHistory,
        selectedReceipt,
        cookieInfo,
        status,
        statusTone,
        progress,
        isLoading,
        isDrawing,
        rollingCandidate,
        phase,
        activeTab,
        showSourceEditor,
        showPrizeEditor,
        showFilters,
        candidateQuery,
        candidateSegment,
        historyExpanded,
        showSettings,
        showGuide,
        showFeedback,
        legalDocument,
        notice,
        apiBase,
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
        filterSummary,
        manualCookieOpen,
        isCapturing,
        motionPreference,
        statusInputRef,
        firstPrizeNameRef,
        setSource,
        setStatusUrl,
        setCurrentStatusUrl,
        setAccessToken,
        setMobileCookie,
        setManualInput,
        setCandidates,
        setPrizes,
        setKeyword,
        setMentionMin,
        setBlocklist,
        setUniqueByUser,
        setExcludePrevious,
        setResults,
        setLastPool,
        setDrawHistory,
        setSelectedReceipt,
        setActiveTab,
        setShowSourceEditor,
        setShowPrizeEditor,
        setShowFilters,
        setCandidateQuery,
        setCandidateSegment,
        setHistoryExpanded,
        setShowSettings,
        setShowGuide,
        setShowFeedback,
        setLegalDocument,
        setApiBase,
        setApiKey,
        setManualCookieOpen,
        setMotionPreference,
        dismissNotice,
        openLegalDocument,
        submitFeedback,
        selectCandidateSource,
        safeLoadCandidates,
        pasteAndLoadCandidates,
        handleStatusPaste,
        clearResult,
        updatePrize,
        updatePrizeCount,
        addPrize,
        removePrize,
        loadCookieStatus,
        testApiConnection,
        drawAll,
        showStatus,
        importCandidateFile,
        addManualNames,
        createShareImage,
        copyReceiptPost,
        copyReceiptFairness,
        retrySaveReceipt,
      }}
    />
  );
}

export default App;
