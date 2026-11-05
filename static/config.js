// 站点运行时配置，由后端服务器直接下发。自建后端部署时，改完这个文件重启服务即可生效，
// 不需要重新构建；纯静态托管（如 GitHub Pages）没有后端，需要重新构建后再推送。
window.WEIBO_DRAW_ALLOWED_API_BASES = window.WEIBO_DRAW_ALLOWED_API_BASES || [
  'https://111.228.11.206',
];
window.WEIBO_DRAW_API_BASE = window.WEIBO_DRAW_API_BASE
  || (window.location.hostname.endsWith('github.io') ? window.WEIBO_DRAW_ALLOWED_API_BASES[0] : '');

// 工程检查必填两项：运营者名称/姓名和有效联系渠道。该文件随前端公开分发，不可填写秘密。
// 检查通过不代表主体身份已核实或法定披露已完整；“Sameko”为当前运营者署名。
// 可选字段留空时使用前端内置默认文案，不会读取服务器环境变量或自动同步实际保存期限。
// 部署参数、托管服务、备份或接收方变化时，必须同步核实并更新本文件及相关法律说明。
// npm run legal:check 在必填缺失、或已填字段像占位文本时阻断发布。
window.WEIBO_DRAW_LEGAL = window.WEIBO_DRAW_LEGAL || {
  operatorName: 'Sameko', // 【必填】运营者署名
  privacyContact: 'loveofcc@gmail.com', // 【必填】联系邮箱
  operatorAddress: '', // 选填，留空时隐私政策不显示地址段落
  hostingProvider: '', // 选填，如自建机房或云服务商
  serverRegion: '美国怀俄明州', // 选填，但必须与真实机房一致
  // 下面按“GitHub Pages 静态前端 + 美国怀俄明州自建后端”的部署方式撰写；换成别的托管方式时请改写。
  dataRecipientDisclosure: 'GitHub Pages 分发静态文件，并按其隐私规则处理访问记录；本应用不将候选名单、开奖结果或填写的微博凭据作为业务数据提交给 GitHub Pages。浏览器会处理候选并保存本机记录；本站后端服务器位于美国怀俄明州，处理微博载入、开奖记录与反馈等数据。微博接口及图片服务接收完成请求所需的信息，浏览器在部分图片加载场景也会直连源站。若运营者启用只读登录态接口，获授权的受信服务可读取服务器登录态。基础设施服务商可能按实际托管安排处理网络与运行数据；变更接收方或用途时应更新披露并履行适用义务。',
  jurisdictionDisclosure: '运营者与本站后端服务器位于美国怀俄明州。适用法律与管辖依法确定，不仅由服务器所在地决定。可通过页面公布的联系邮箱协商，亦可依法向有管辖权的机构或法院寻求救济；协商不是行使法定权利的前置条件。',
  recordRetentionDisclosure: '', // 选填；留空使用前端所列程序默认值，修改 MAX_SAVED_DRAWS 等参数后须人工同步
  credentialRetentionDisclosure: '', // 选填；留空使用前端默认说明，凭据保存或撤销方式变化后须人工同步
};
