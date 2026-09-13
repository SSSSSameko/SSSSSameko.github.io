# sameko-weibo-lottery 项目说明

## 范围

本项目仅指 `D:\开发\sameko-weibo-lottery`。不要跨项目修改 KiraFiesta、
idol-polaroid、ClownPush 或其他目录。

## 代码基线

- 版本：`3.5.0`
- 分支：`main`
- 交接提交：`fab456434473b3655f250386a8018ffd052dcfae`
- 远端：`https://github.com/SSSSSameko/SSSSSameko.github.io.git`
- 前端部署：GitHub Pages
- 后端接口：`https://111.228.11.206`

先运行 `git status --short --branch`，不要把 `output/`、`.env`、Cookie、登录
Profile、密钥或本机运行数据提交到 Git。

## 常用命令

```powershell
npm ci
npm test
npm run build
npm run licenses:check
npm run legal:check
npm start
```

默认本地地址是 `http://127.0.0.1:4173/`。提交前至少运行
`npm test`、`npm run build`、`npm run licenses:check` 和
`npm run legal:check`。发布前按 `README.md` 运行完整的
`npm run test:release`。

## 关键约束

- `output/legacy-local-20260910/` 是从旧工作树迁移的本机开奖数据，已由
  `.gitignore` 排除，不要删除或提交。
- 不要迁移或提交 `output/auth/weibo-login-profile/`、
  `weibo-login-state.json`、Cookie、服务器密钥或请求日志。
- 只读 Cookie 接口契约在 `docs/COOKIE-API-CLIENT.md`。不要把调用密钥写入
  仓库、前端、公开文档、截图或日志。
- 版本历史见 `docs/CHANGELOG.md`，部署和运行边界见 `README.md`。
- 当前环境可能使用 Mihomo，`sinaimg.cn` 会被解析到 `198.18.0.49`。
  不要为了通过测试而放宽生产 SSRF 校验。

## 重要遗留

公开法律文案已于 2026-09-13 固定为“服务器位于美国怀俄明州”。
如运营主体或部署方式发生变化，必须先重新核实再修改法律文案。

仓库内视觉素材的外部来源和授权证明不完整。公开上线或再分发前，必须按
`docs/ASSET-NOTICES.md` 逐项确认。

## 交接入口

精简后的开发背景、架构决策、本机数据和上线前风险见
`开发交接总结.md`。
