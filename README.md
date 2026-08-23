# 微博转发抽奖助手

当前版本：`3.0.0`

用于微博转发抽奖的网页工具，支持候选抓取、名单导入、滚动开奖、开奖记录图和后台管理。

## 功能

- 微博可见转发候选抓取
- 手动名单导入
- 自定义奖项和名额
- 滚动开奖动画
- 开奖记录图、CSV 导出
- 后台开奖记录管理
- 服务器 Cookie 池、扫码登录和自动保活
- 抓取队列、接口限流和分页延迟

## 本地运行

```bash
npm install
npm run build
npm start
```

默认访问地址：

```text
http://127.0.0.1:4173/
```

## 配置

前端可托管到 GitHub Pages，后端部署到服务器。公开前端通过 `static/config.js` 指向后端 API。

常用环境变量：

- `HOST=127.0.0.1`
- `PORT=4173`
- `CORS_ORIGINS=https://你的前端域名`
- `ADMIN_KEY=你的后台密钥`
- `ADMIN_USERNAME=后台账号`
- `ADMIN_PASSWORD_HASH=scrypt 密码哈希`
- `ADMIN_SESSION_SECRET=随机会话密钥`
- `COOKIE_WRITE_KEY=仅供服务器 Cookie 池维护使用的独立密钥（通过 x-cookie-write-key 请求头提供）`
- `SOURCE_FINGERPRINT_SECRET=反馈匿名来源标识密钥（可复用会话密钥）`
- `PLAYWRIGHT_BROWSERS_PATH=/opt/sameko-weibo-lottery/ms-playwright`
- `MAX_DRAW_SAVE_BODY_BYTES=2097152`
- `MAX_CANDIDATES=20000`（单次任务的容量上限，不代表微博一定能返回这么多可见转发）
- `DESKTOP_MAX_PAGES=1000`
- `PAGE_DELAY_JITTER_MS=1500`
- `PAGE_COOLDOWN_EVERY=8`
- `PAGE_COOLDOWN_MS=5000`
- `WEIBO_THROTTLE_RETRY_MAX=2`

生产环境必须使用至少 32 字节的 `ADMIN_SESSION_SECRET`。未配置 `COOKIE_WRITE_KEY` 时，公开抓取请求无法写入或校验服务器 Cookie 池；用户临时填写的 Cookie 仍只用于当前任务。

分页抓取会在每页之间随机等待，并按固定页数进行额外冷却。遇到微博 `418`、`429` 或临时 `503` 时，服务会尊重 `Retry-After` 并退避重试。实际候选数量仍取决于微博接口可见范围、账号权限和接口返回的最大页数。

运行数据保存在 `output/`，浏览器登录资料保存在 `output/auth/weibo-login-profile/`。这些目录不提交到 Git。

## 后台管理

后端部署完成后访问：

```text
https://你的后端地址/admin
```

使用服务器配置的账号和密码登录。`ADMIN_KEY` 仅保留给接口运维调用，不会显示在登录页。后台可以查看开奖记录、中奖明细、最近开奖动作、抓取队列、内存趋势和 Cookie 保活状态。

版本记录：见 `docs/CHANGELOG.md`；站内可从“更多 → 关于此应用 → 更新日志”查看。
