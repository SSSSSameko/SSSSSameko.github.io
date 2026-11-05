import SheetFrame from '../ui/SheetFrame.jsx';
import { icons as I } from '../ui/icons.jsx';
const GUIDE_STEPS = [
  ['1', '载入候选', '粘贴微博正文链接、mid 或 bid。应用优先使用服务器登录态，不可用时再尝试备用 Cookie。'],
  ['2', '核对名单', '确认候选人数和筛选结果。你也可以手动填写名单，或导入 CSV、TXT、TSV 和 JSON 文件。'],
  ['3', '确认抽奖设置', '检查奖项顺序、中奖人数和筛选规则。中奖总人数不能超过可抽人数。'],
  ['4', '核对并开奖', '在开奖确认页核对候选、奖项和历史次数，再开始抽取。完成后可保存结果图或复制公示文案。'],
];

export default function GuideSheet({ onClose }) {
  return (
    <SheetFrame
      title="使用教程"
      tone="coral"
      subtitle="从载入候选到保存结果"
      icon={I.book}
      onClose={onClose}
      className="flow-guide-sheet"
      footer={(close) => (
        <button type="button" onClick={() => close()} className="flow-sheet-primary v3-primary-action">知道了</button>
      )}
    >
      {() => (
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
        </>
      )}
    </SheetFrame>
  );
}
