// 站点运行时配置，由后端服务器直接下发。自建后端部署时，改完这个文件重启服务即可生效，
// 不需要重新构建；纯静态托管（如 GitHub Pages）没有后端，需要重新构建后再推送。
window.WEIBO_DRAW_ALLOWED_API_BASES = window.WEIBO_DRAW_ALLOWED_API_BASES || [
  'https://111.228.11.206',
];
window.WEIBO_DRAW_API_BASE = window.WEIBO_DRAW_API_BASE
  || (window.location.hostname.endsWith('github.io') ? window.WEIBO_DRAW_ALLOWED_API_BASES[0] : '');

// 必填只有两项：运营者署名和一条长期有效的联系邮箱。这两项只显示在隐私政策页，不会提交给
// 任何第三方。其余字段留空时按程序的实际运行参数自动生成；与实际部署不一致时再覆盖。
// npm run legal:check 会在两项必填缺失、或任何已填字段像占位文本时阻断发布。
window.WEIBO_DRAW_LEGAL = window.WEIBO_DRAW_LEGAL || {
  operatorName: 'Sameko', // 【必填】运营者署名
  privacyContact: 'loveofcc@gmail.com', // 【必填】联系邮箱
  operatorAddress: '', // 选填，留空时隐私政策不显示地址段落
  hostingProvider: '', // 选填，如自建机房或云服务商
  serverRegion: '', // 选填，如“美国（怀俄明州）”
  // 下面按“GitHub Pages 静态前端 + 美国自建后端”的部署方式撰写；换成别的托管方式时请改写。
  dataRecipientDisclosure: '前端静态页面由 GitHub Pages 托管，只分发 HTML、CSS 和 JavaScript 文件，不接收候选名单、开奖结果或登录态；后端为运营者自建服务器，位于美国，候选数据、开奖记录和服务器登录资料只保存在该服务器上。除为完成载入而向微博接口发出的必要请求外，不向其他第三方提供数据，也不委托第三方处理。',
  jurisdictionDisclosure: '本站由个人搭建，运营者与后端服务器均位于美国，适用美国怀俄明州法律及适用的美国联邦法律。因本站产生的争议，应先通过页面公布的联系邮箱协商解决；协商不成的，提交怀俄明州有管辖权的法院处理。',
  recordRetentionDisclosure: '', // 选填，留空时按当前上限（MAX_SAVED_DRAWS 等）自动生成；改了这些上限再覆盖这里
  credentialRetentionDisclosure: '', // 选填，留空时按 Cookie 池与隔离策略自动生成
};
