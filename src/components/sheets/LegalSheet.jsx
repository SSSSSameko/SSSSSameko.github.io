import { useEffect, useState } from 'react';
import SheetFrame from '../ui/SheetFrame.jsx';
import { icons as I } from '../ui/icons.jsx';

const APP_VERSION = __APP_VERSION__;

function UpdateEntry({ entry }) {
  return (
    <article className="flow-update-entry">
      <header>
        <div><strong>版本 {entry.version}</strong><small>{entry.date}</small></div>
        <span>{entry.label}</span>
      </header>
      <h3>{entry.title}</h3>
      {entry.summary && <p>{entry.summary}</p>}
      {entry.items.length > 0 && <ul>{entry.items.map((item) => <li key={item}>{item}</li>)}</ul>}
    </article>
  );
}

export default function LegalSheet({ document, onClose, onOpenPrivacyRequest, onOpenUpdates }) {
  const [showUpdateHistory, setShowUpdateHistory] = useState(false);
  const documentKey = document?.key || '';
  useEffect(() => { setShowUpdateHistory(false); }, [documentKey]);
  if (!document) return null;
  return (
    <SheetFrame
      key={document.key || document.title}
      title={document.title}
      subtitle={document.subtitle}
      icon={document.key === 'updates' ? I.history : I.file}
      onClose={onClose}
      className="flow-legal-sheet"
      footer={(close) => (
        <button type="button" onClick={() => close()} className="flow-sheet-primary v3-primary-action">完成</button>
      )}
    >
      {(close) => (
        <>
          {document.key === 'updates' && document.updates?.[0]?.date && <p className="flow-legal-date">更新日期：{document.updates[0].date}</p>}
          {document.updates ? (
            <>
              <div className="flow-update-list">
                {document.updates.slice(0, 1).map((entry) => <UpdateEntry entry={entry} key={entry.version} />)}
              </div>
              {document.updates.length > 1 && (
                <>
                  <button
                    type="button"
                    className="flow-update-history-toggle"
                    aria-expanded={showUpdateHistory}
                    onClick={() => setShowUpdateHistory((value) => !value)}
                  >
                    <span>{showUpdateHistory ? '收起历史版本' : `查看历史版本（${document.updates.length - 1} 个）`}</span>
                    {I.chevron}
                  </button>
                  {showUpdateHistory && (
                    <div className="flow-update-list flow-update-history">
                      {document.updates.slice(1).map((entry) => <UpdateEntry entry={entry} key={entry.version} />)}
                    </div>
                  )}
                </>
              )}
            </>
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
                  <span className="row-copy"><strong>第三方许可清单</strong><small>查看收录的版权声明与许可文本</small></span>
                  {I.chevron}
                </a>
              )}
              {document.contactEmail && (
                <a className="flow-legal-update-link list-row" href={`mailto:${encodeURIComponent(document.contactEmail)}`}>
                  <span className="row-icon mint">{I.send}</span>
                  <span className="row-copy"><strong>通过邮箱联系运营者</strong><small>{document.contactEmail}</small></span>
                  {I.chevron}
                </a>
              )}
              {document.key === 'privacy' && (
                <button type="button" className="flow-legal-update-link list-row" onClick={() => close(onOpenPrivacyRequest)}>
                  <span className="row-icon lilac">{I.feedback}</span>
                  <span className="row-copy"><strong>提交隐私问题反馈</strong><small>匿名反馈；如需回复请通过邮箱联系</small></span>
                  {I.chevron}
                </button>
              )}
            </>
          )}
        </>
      )}
    </SheetFrame>
  );
}
