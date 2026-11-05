import SheetFrame from '../ui/SheetFrame.jsx';
import { icons as I } from '../ui/icons.jsx';

export default function DisplayModeSheet({ mode, onClose }) {
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return (
    <SheetFrame title="全屏与主屏幕" icon={I.expand} onClose={onClose} returnFocusId="display-mode-entry"
      footer={(close) => <button className="flow-sheet-primary" type="button" onClick={() => close()}>知道了</button>}>
      <div className="display-mode-guide">
        <p className="display-mode-lead">{mode.standalone
          ? '当前已从主屏幕打开，浏览器工具栏已隐藏。'
          : '从主屏幕打开，让抽奖页面独占一个窗口。'}</p>
        {mode.error && <p className="display-mode-error" role="alert">{mode.error}</p>}
        {!mode.standalone && <>
          <ol>
            <li><span>{I.share}</span><div><strong>{apple ? '在 Safari 中打开分享菜单' : '打开浏览器菜单'}</strong><p>{apple ? '点击分享图标；部分版本需要先打开“更多”。' : '找到“安装应用”或“添加到主屏幕”。'}</p></div></li>
            <li><span>{I.plus}</span><div><strong>选择“添加到主屏幕”</strong><p>{apple ? '若看到“作为网页 App 打开”，请保持开启，再点“添加”。' : '按浏览器提示确认添加。'}</p></div></li>
            <li><span>{I.gift}</span><div><strong>从桌面图标进入</strong><p>以后直接打开“微博抽奖”，保留完整的操作空间。</p></div></li>
          </ol>
          <p className="display-mode-note">{apple ? 'iPhone 的 Safari 标签页不能由网站强制隐藏地址栏。' : '不同浏览器的菜单名称可能略有区别。'} 本机记录可能与原浏览器窗口分开保存，重要记录请先在数据设置中导出备份。</p>
        </>}
      </div>
    </SheetFrame>
  );
}
