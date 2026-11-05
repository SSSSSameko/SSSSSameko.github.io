import { useEffect, useState } from 'react';
import SheetFrame from '../ui/SheetFrame.jsx';
import { icons as I } from '../ui/icons.jsx';
import { DRAW_HISTORY_LIMIT } from '../../lib/drawReceipts.js';
import { MOTION_OPTIONS, shouldReduceMotion } from '../../lib/motionPreferences.js';

const publicAsset = (name) => import.meta.env.BASE_URL + name;
const APP_VERSION = __APP_VERSION__;

export default function SettingsSheet({
  accountStatusText,
  apiAuthRequired,
  apiHealth,
  apiHealthDetail,
  apiBaseInput,
  apiKey,
  backendAddressEditorOpen,
  drawHistory,
  cookieHealth,
  loadCookieStatus,
  exportHistoryBackup,
  historyImportInputRef,
  isImportingHistory,
  importHistoryBackup,
  mobileCookie,
  motionPreference,
  openBackendAddressEditor,
  saveBackendAddress,
  serviceStatusText,
  setApiBaseInput,
  setApiKey,
  setConfirmAction,
  setMobileCookie,
  setMotionPreference,
  setShowSettings,
  settingsTarget,
  showStatus,
  testApiConnection,
  usePresetBackend,
}) {
  const [settingsDisclosures, setSettingsDisclosures] = useState({ cookie: false, backend: false });
  const motionSegmentIndex = Math.max(
    0,
    MOTION_OPTIONS.findIndex((option) => option.value === motionPreference),
  );
  useEffect(() => {
    if (settingsTarget === 'cookie' || settingsTarget === 'backend') {
      setSettingsDisclosures((current) => ({ ...current, [settingsTarget]: true }));
    }
    if (!settingsTarget || settingsTarget === 'overview') return undefined;
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-settings-section="${settingsTarget}"]`)?.scrollIntoView({
        block: 'start',
        behavior: shouldReduceMotion(motionPreference) ? 'auto' : 'smooth',
      });
    }, 360);
    return () => window.clearTimeout(timer);
  }, [motionPreference, settingsTarget]);

  return (
    <SheetFrame
      title="设置"
      tone="lilac"
      subtitle="显示、数据与后端连接"
      icon={I.settings}
      onClose={() => setShowSettings(false)}
      className="v3-editor-sheet"
      footer={(close) => (
        <button
          type="button"
          className="flow-sheet-primary v3-primary-action"
          onClick={() => close()}
        >
          完成
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="flow-app-summary">
            <img src={publicAsset('avatar-96.webp')} alt="" width="72" height="72" />
            <div>
              <strong>微博转发抽奖</strong>
              <p>版本 {APP_VERSION} · by.sameko</p>
            </div>
            <span>{accountStatusText}</span>
          </div>
          <h3 className="flow-settings-caption">动效</h3>
          <div className="flow-motion-setting">
            <div className="flow-motion-heading">
              <span>{I.zap}</span>
              <div>
                <strong>界面动效</strong>
                <small>
                  {motionPreference === 'full'
                    ? '完整动画与玻璃效果'
                    : motionPreference === 'reduced'
                      ? '减少位移，保留操作反馈'
                      : '跟随系统的动画与透明度设置'}
                </small>
              </div>
            </div>
            <div
              className="segmented-control motion-segmented"
              role="group"
              aria-label="开奖动效强度"
              style={{ '--segment-index': motionSegmentIndex }}
            >
              <span className="segmented-highlight" aria-hidden="true" />
              {MOTION_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={motionPreference === option.value ? 'is-active' : ''}
                  aria-pressed={motionPreference === option.value}
                  onClick={() => setMotionPreference(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <h3 className="flow-settings-caption" data-settings-section="records">
            记录与数据
          </h3>
          <div className="flow-settings-list">
            <button type="button" onClick={exportHistoryBackup} disabled={!drawHistory.length}>
              <span>{I.download}</span>
              <div>
                <strong>导出开奖记录</strong>
                <small>备份当前浏览器最近 {DRAW_HISTORY_LIMIT} 条记录</small>
              </div>
              <em className="flow-settings-action-label is-neutral">导出</em>
            </button>
            <button type="button" onClick={() => historyImportInputRef.current?.click()} disabled={isImportingHistory} aria-busy={isImportingHistory}>
              <span>{I.archive}</span>
              <div>
                <strong>恢复开奖记录</strong>
                <small>合并本应用导出的记录备份，不覆盖现有记录</small>
              </div>
              <em className="flow-settings-action-label is-neutral">{isImportingHistory ? '正在读取备份' : '选择文件'}</em>
            </button>
            <input
              ref={historyImportInputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={importHistoryBackup}
            />
            <button
              type="button"
              onClick={() =>
                close(() =>
                  setConfirmAction({
                    kind: 'current-draw',
                    title: '清空当前抽奖？',
                    message: '当前候选和尚未保存的结果会被移除，服务器开奖记录不受影响。',
                  }),
                )
              }
            >
              <span>{I.trash}</span>
              <div>
                <strong>清空当前抽奖</strong>
                <small>移除当前候选与结果，不影响服务器记录</small>
              </div>
              <em className="flow-settings-action-label">清空</em>
            </button>
            <button
              type="button"
              onClick={() => {
                setMobileCookie('');
                showStatus('已清空备用 Cookie。', 'success', { popup: true, title: '已清空' });
              }}
            >
              <span>{I.shield}</span>
              <div>
                <strong>清除备用 Cookie</strong>
                <small>不会修改服务器登录态</small>
              </div>
              <em className="flow-settings-action-label">清除</em>
            </button>
            <button
              type="button"
              onClick={() =>
                close(() =>
                  setConfirmAction({
                    kind: 'local-history',
                    title: '清空本机抽奖数据？',
                    message:
                      '当前浏览器中的开奖记录、旧版记录、异常恢复副本和防重复状态会被移除；服务器记录、界面偏好与后端地址不会删除。',
                  }),
                )
              }
            >
              <span>{I.clock}</span>
              <div>
                <strong>清空本机抽奖数据</strong>
                <small>移除记录、恢复副本与防重复状态</small>
              </div>
              <em className="flow-settings-action-label">清空</em>
            </button>
          </div>
          <details
            className="flow-connection-details"
            data-settings-section="cookie"
            open={settingsDisclosures.cookie}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setSettingsDisclosures((current) =>
                current.cookie === open ? current : { ...current, cookie: open },
              );
            }}
          >
            <summary>
              <span>
                <strong>备用 Cookie</strong>
                <small>{accountStatusText}</small>
              </span>
              {I.chevron}
            </summary>
            <div className="flow-settings-form">
              <div
                className={`connection-status${cookieHealth === 'error' ? ' is-error' : ''}`}
                role="status"
              >
                <p>{accountStatusText}</p>
                <button
                  type="button"
                  onClick={() => loadCookieStatus(false)}
                  aria-busy={cookieHealth === 'checking'}
                >
                  刷新登录态
                </button>
              </div>
              <label className="flow-field-block">
                <span>仅在服务器登录态不可用时尝试</span>
                <textarea
                  value={mobileCookie}
                  onChange={(event) => setMobileCookie(event.target.value)}
                  name="settingsMobileCookie"
                  autoComplete="off"
                  spellCheck="false"
                  placeholder="粘贴本人有权使用的微博 Cookie…"
                />
              </label>
              <p className="v3-credential-notice">
                仅在当前任务中处理，任务结束后清除，不写入服务器 Cookie 池。
              </p>
            </div>
          </details>
          <details
            className="flow-connection-details"
            data-settings-section="backend"
            open={settingsDisclosures.backend}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setSettingsDisclosures((current) =>
                current.backend === open ? current : { ...current, backend: open },
              );
            }}
          >
            <summary>
              <span>
                <strong>后端连接</strong>
                <small>{serviceStatusText}</small>
              </span>
              {I.chevron}
            </summary>
            <div className="flow-settings-form">
              <div
                className={`connection-status${apiHealth === 'error' ? ' is-error' : ''}`}
                role="status"
              >
                <p>
                  <strong>{serviceStatusText}</strong>
                  {apiHealthDetail && <small>{apiHealthDetail}</small>}
                </p>
              </div>
              {backendAddressEditorOpen ? (
                <label className="flow-field-block">
                  <span>自定义后端地址</span>
                  <input
                    name="backendAddress"
                    autoComplete="off"
                    inputMode="url"
                    spellCheck="false"
                    value={apiBaseInput}
                    onChange={(event) => setApiBaseInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') saveBackendAddress();
                    }}
                    placeholder="例如 http://127.0.0.1:4173"
                  />
                </label>
              ) : (
                <div className="flow-field-block">
                  <span>后端地址</span>
                  <p className="flow-field-hint">
                    已使用预置服务地址，默认不在页面上显示。需要连接本机或自建服务时再手动填写。
                  </p>
                </div>
              )}
              <label className="flow-field-block">
                <span>访问密钥（按部署要求）</span>
                <input
                  name="backendAccessKey"
                  autoComplete="off"
                  spellCheck="false"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  type="password"
                  placeholder={apiAuthRequired ? '该后端要求密钥，请填写…' : '公开模式不用填写…'}
                />
              </label>
              {apiAuthRequired && !apiKey.trim() && (
                <p className="flow-field-hint">
                  当前后端开启了访问密钥校验，未填写时候选载入和记录保存都会返回 401。
                </p>
              )}
              <div className="flow-settings-actions">
                {backendAddressEditorOpen ? (
                  <>
                    <button type="button" onClick={saveBackendAddress}>
                      保存并使用
                    </button>
                    <button type="button" onClick={usePresetBackend}>
                      使用预置地址
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={testApiConnection}>
                      测试连接
                    </button>
                    <button type="button" onClick={openBackendAddressEditor}>
                      手动填写地址
                    </button>
                  </>
                )}
              </div>
            </div>
          </details>
        </>
      )}
    </SheetFrame>
  );
}
