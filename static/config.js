// 站点运行时配置，由后端服务器直接下发。自建后端部署时，改完这个文件重启服务即可生效，
// 不需要重新构建；纯静态托管（如 GitHub Pages）没有后端，需要重新构建后再推送。
window.WEIBO_DRAW_ALLOWED_API_BASES = window.WEIBO_DRAW_ALLOWED_API_BASES || [
  'https://111.228.11.206',
];
window.WEIBO_DRAW_API_BASE = window.WEIBO_DRAW_API_BASE
  || (window.location.hostname.endsWith('github.io') ? window.WEIBO_DRAW_ALLOWED_API_BASES[0] : '');

// 必填只有两项：处理者署名和一条长期有效的联系邮箱。《个人信息保护法》第 17 条要求告知
// 「名称或者姓名」，填真实姓名或个体、工作室名称最稳妥；若你只把本站用于自己和熟人、
// 不对外推广，也可以填长期使用的署名——该法第 72 条对自然人因个人或家庭事务处理个人信息
// 有豁免空间，但一旦变成面向不特定公众的服务，豁免就不再适用。这两项只显示在你自己的
// 隐私政策页，不会提交给任何第三方。其余字段留空时按程序的实际运行参数自动生成；
// 与实际部署不一致时（例如前端托管在 GitHub Pages、另外接了 CDN 或第三方统计）再覆盖。
// npm run legal:check 会在两项必填缺失、或任何已填字段像占位文本时阻断发布。
window.WEIBO_DRAW_LEGAL = window.WEIBO_DRAW_LEGAL || {
  operatorName: 'Sameko', // 【必填】处理者署名
  privacyContact: 'loveofcc@gmail.com', // 【必填】权利受理邮箱
  operatorAddress: '', // 选填，留空时隐私政策不显示地址段落
  hostingProvider: '', // 选填，如腾讯云、阿里云或自建机房
  serverRegion: '', // 选填，如“中国大陆（上海）”
  // 下面按“GitHub Pages 静态前端 + 美国自建后端”的部署方式撰写；换成别的托管方式时请改写。
  dataRecipientDisclosure: '前端静态页面由 GitHub Pages 托管，只分发 HTML、CSS 和 JavaScript 文件，不接收候选名单、开奖结果或登录态；后端为运营者自建服务器，位于美国，候选数据、开奖记录和服务器登录资料只保存在该服务器上。除为完成载入而向微博接口发出的必要请求外，不向其他第三方提供个人信息，也不委托第三方处理个人信息。',
  jurisdictionDisclosure: '本服务的后端服务器与数据存储位于美国，不设在中国大陆境内，也不在香港特别行政区、澳门特别行政区或台湾地区。本说明、使用规则以及因使用本服务产生的争议，适用中华人民共和国大陆地区法律；争议应先通过页面公布的联系渠道协商解决，协商不成的，提交运营者所在地有管辖权的人民法院处理。服务器位于境外不改变个人信息保护规则的适用：处理中国大陆居民个人信息时，本应用仍按《个人信息保护法》履行告知、最小必要与安全保护义务，跨境安排见隐私政策「跨境处理」一节。',
  recordRetentionDisclosure: '', // 选填，留空时按当前上限（MAX_SAVED_DRAWS 等）自动生成；改了这些上限再覆盖这里
  credentialRetentionDisclosure: '', // 选填，留空时按 Cookie 池与隔离策略自动生成
  backupRetentionDisclosure: '', // 选填，留空时按“本应用不创建备份副本，快照由基础设施决定”生成
  crossBorderDisclosure: '前端静态页面托管在 GitHub Pages（GitHub, Inc.，美国），后端服务器与数据存储位于美国，前后端都在中国大陆境外。载入候选时，浏览器会把微博链接和当前登录态直接发往该境外服务器，服务器再向微博接口发起请求。按照《个人信息保护法》第 38 条，向境外提供个人信息需要具备法定条件，并向个人告知境外接收方的名称、联系方式、处理目的、处理方式、个人信息种类和行使权利的方式。本服务仅面向运营者本人及其小范围熟人，如你不接受该安排，请不要提交任何个人信息。',
};
