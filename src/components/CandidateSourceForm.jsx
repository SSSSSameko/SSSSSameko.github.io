import {
  ChevronRight,
  Download,
  Link2,
  RefreshCw,
  ShieldCheck,
  Upload,
  Users,
} from 'lucide-react';

const SOURCE_OPTIONS = [
  { value: 'mobile', label: '微博链接' },
  { value: 'manual', label: '手动名单' },
  { value: 'official', label: '官方接口' },
];

const ICONS = {
  link: <Link2 className="icon-18" strokeWidth={1.8} />,
  refresh: <RefreshCw className="icon-16" strokeWidth={1.8} />,
  shield: <ShieldCheck className="icon-16" strokeWidth={1.7} />,
  upload: <Upload className="icon-16" strokeWidth={1.8} />,
  download: <Download className="icon-16" strokeWidth={1.8} />,
  users: <Users className="icon-18" strokeWidth={1.5} />,
  chevron: <ChevronRight className="icon-16" strokeWidth={1.8} />,
};

function SourceSelector({ source, onChange }) {
  const segmentIndex = Math.max(
    0,
    SOURCE_OPTIONS.findIndex((option) => option.value === source),
  );

  return (
    <div
      className="segmented-control v3-source-control"
      role="group"
      aria-label="候选来源"
      style={{ '--segment-index': segmentIndex }}
    >
      <span className="segmented-highlight" aria-hidden="true" />
      {SOURCE_OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          className={source === value ? 'is-active' : ''}
          aria-pressed={source === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function SheetCallout({ tone, icon, title, detail }) {
  return (
    <div className="v3-sheet-callout">
      <span className={`row-icon ${tone}`}>{icon}</span>
      <div><strong>{title}</strong><small>{detail}</small></div>
    </div>
  );
}

function MobileSourceFields({ controller: c, sheet }) {
  return (
    <div className={`v3-source-form${sheet ? ' v3-sheet-source-form' : ''}`}>
      {sheet && (
        <SheetCallout
          tone="blue"
          icon={ICONS.link}
          title="微博链接载入"
          detail="读取当前登录态及微博接口可见的转发"
        />
      )}
      <label className="v3-link-field">
        <span className="sr-only">微博链接、mid 或 bid</span>
        <input
          ref={sheet ? c.sourceSheetStatusInputRef : c.candidateStatusInputRef}
          value={c.statusUrl}
          onChange={(event) => c.updateStatusInput(event.target.value)}
          name={sheet ? 'sourceSheetStatusUrl' : 'candidateStatusUrl'}
          inputMode="url"
          autoComplete="off"
          placeholder="微博正文链接、mid 或 bid"
        />
      </label>

      {sheet ? (
        <button
          className="v3-pearl-action v3-primary-action"
          type="button"
          onClick={c.pasteAndLoadCandidates}
          disabled={c.isLoading}
        >
          <span className="v3-pearl-icon">{c.isLoading ? ICONS.refresh : ICONS.link}</span>
          <span className="v3-pearl-copy">
            <strong>{c.isLoading ? '正在载入候选' : c.statusUrl.trim() ? '载入候选' : '粘贴链接并载入'}</strong>
            <small>自动识别微博正文链接、mid 或 bid</small>
          </span>
          <span className="v3-pearl-arrow">{ICONS.chevron}</span>
        </button>
      ) : (
        <button
          className="v3-solid-action v3-primary-action"
          type="button"
          onClick={c.pasteAndLoadCandidates}
          disabled={c.isLoading}
        >
          {c.isLoading ? ICONS.refresh : ICONS.link}
          {c.isLoading ? '正在载入' : c.statusUrl.trim() ? '载入候选' : '粘贴并载入'}
        </button>
      )}

      <div className="v3-cookie-row">
        <span className="row-icon blue">{ICONS.shield}</span>
        <span><strong>{c.accountStatusText}</strong><small>服务器登录态优先</small></span>
        <button type="button" onClick={() => c.loadCookieStatus(false)}>刷新</button>
      </div>
      <button
        className="v3-disclosure"
        type="button"
        onClick={() => c.setManualCookieOpen((value) => !value)}
        aria-expanded={c.manualCookieOpen}
      >
        <span>备用 Cookie</span>
        <span>{c.manualCookieOpen ? '收起' : '展开'} {ICONS.chevron}</span>
      </button>
      {c.manualCookieOpen && (
        <>
          <textarea
            className="v3-textarea"
            value={c.mobileCookie}
            onChange={(event) => c.setMobileCookie(event.target.value)}
            name={sheet ? 'sourceSheetMobileCookie' : 'mobileCookie'}
            autoComplete="off"
            spellCheck="false"
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
  );
}

function ManualSourceFields({ controller: c, sheet }) {
  return (
    <div className={`v3-source-form${sheet ? ' v3-sheet-source-form' : ''}`}>
      {sheet && (
        <SheetCallout
          tone="coral"
          icon={ICONS.users}
          title="手动名单"
          detail="每行一个昵称，也可导入带表头的 CSV、TSV 或 JSON"
        />
      )}
      <textarea
        className="v3-textarea v3-list-input"
        value={c.manualInput}
        onChange={(event) => c.updateManualInput(event.target.value)}
        name={sheet ? 'sourceSheetManualCandidates' : 'manualCandidateInput'}
        autoComplete="off"
        aria-label={sheet ? '弹窗手动候选名单' : '手动候选名单'}
        placeholder="每行一个昵称；CSV 建议使用 uid,screenName 表头。"
      />
      <div className="v3-action-row">
        <label className="v3-file-action">
          {ICONS.upload}
          <span>选择文件</span>
          <input
            type="file"
            accept=".csv,.txt,.tsv,.json,text/csv,text/plain,application/json"
            onChange={c.importCandidateFile}
          />
        </label>
        <button type="button" onClick={() => c.safeLoadCandidates({ jumpAfterLoad: false })}>替换名单</button>
        <button type="button" onClick={c.addManualNames}>追加</button>
      </div>
    </div>
  );
}

function OfficialSourceFields({ controller: c, sheet }) {
  const loadCandidates = () => c.safeLoadCandidates({
    jumpAfterLoad: false,
    forceRefresh: c.shouldForceCandidateRefresh(c.statusUrl),
  });

  return (
    <div className={`v3-source-form${sheet ? ' v3-sheet-source-form' : ''}`}>
      {sheet && (
        <SheetCallout
          tone="mint"
          icon={ICONS.shield}
          title="官方接口"
          detail="使用微博官方访问令牌载入候选"
        />
      )}
      <label className="v3-link-field">
        <span className="sr-only">微博链接、mid 或 bid</span>
        <input
          value={c.statusUrl}
          onChange={(event) => c.updateStatusInput(event.target.value)}
          name={sheet ? 'sourceSheetOfficialStatusUrl' : 'officialStatusUrl'}
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
          name={sheet ? 'sourceSheetAccessToken' : 'accessToken'}
          type="password"
          autoComplete="off"
          spellCheck="false"
          placeholder="输入官方访问令牌"
        />
      </label>
      <p className="v3-credential-notice">
        访问令牌会发送至本应用服务器，仅用于当前任务。请使用微博官方授权获得的令牌。
        <button type="button" onClick={() => c.openLegalDocument('privacy')}>查看隐私政策</button>
      </p>

      {sheet ? (
        <button
          className="v3-pearl-action v3-primary-action"
          type="button"
          onClick={loadCandidates}
          disabled={c.isLoading}
        >
          <span className="v3-pearl-icon">{c.isLoading ? ICONS.refresh : ICONS.download}</span>
          <span className="v3-pearl-copy">
            <strong>{c.isLoading ? '正在载入候选' : '通过官方接口载入'}</strong>
            <small>令牌仅用于当前载入任务</small>
          </span>
          <span className="v3-pearl-arrow">{ICONS.chevron}</span>
        </button>
      ) : (
        <button
          className="v3-solid-action v3-primary-action"
          type="button"
          onClick={loadCandidates}
          disabled={c.isLoading}
        >
          {ICONS.download}
          通过官方接口载入
        </button>
      )}
    </div>
  );
}

export default function CandidateSourceForm({ controller: c, variant = 'page' }) {
  const sheet = variant === 'sheet';
  const changeSource = (nextSource) => {
    if (nextSource === c.source || !c.setSource(nextSource)) return;
    c.clearResult(sheet ? undefined : '候选来源已更新，请重新开奖。');
  };

  return (
    <>
      <SourceSelector source={c.source} onChange={changeSource} />
      {c.source === 'mobile' && <MobileSourceFields controller={c} sheet={sheet} />}
      {c.source === 'manual' && <ManualSourceFields controller={c} sheet={sheet} />}
      {c.source === 'official' && <OfficialSourceFields controller={c} sheet={sheet} />}
    </>
  );
}
