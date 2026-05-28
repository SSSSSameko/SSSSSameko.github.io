# 微博转发抽奖助手

这个项目现在包含两部分：

- 微博转发抽奖工作台：用于载入转发候选、筛选、开奖、保存结果和生成开奖记录图。
- 红包 H5 探测脚本：用于用 Playwright 模拟移动浏览器检查微博粉丝红包 H5 页面状态。

如果你问“这个是不是之前做的网页抽奖”，答案是：是的，`public/index.html` 里原来就是微博转发抽奖网页；同时项目还保留了早期的红包 H5 探测脚本。

## 适合 2C / 2GB / 3Mbps 服务器的方案

推荐系统：Debian 13 minimal。

原因：比 Windows 和完整 Ubuntu 更省内存，Node.js、Caddy、systemd 都好装，2GB 内存更舒服。想省心也可以用 Ubuntu 24.04 LTS，但这台配置优先 Debian 13 minimal。

推荐部署：

- 前端：Vite 构建后的静态文件。优先放 GitHub Pages，省服务器带宽。
- 后端：Node.js 24 LTS 跑 `server.mjs`，只处理 API、Cookie 池、开奖记录。
- HTTPS：Caddy 反向代理，自动申请证书，并启用 gzip/zstd 压缩。
- 常驻进程：Linux 用 systemd，比 PM2 更轻。Windows 才考虑 PM2 或 NSSM。

GitHub 可以用，但不要把 `profiles/`、`output/`、`.env`、Cookie、登录态传上去；这些已经在 `.gitignore` 里忽略。

## 本地开发

```bash
npm install
npm run dev
```

默认 Vite 地址通常是：

```text
http://localhost:5173
```

开发时前端会请求同域 API；如果只跑 Vite、不跑 Node API，可以在右上角设置里填后端地址。

## 生产构建和运行

```bash
npm install
npm run build
npm start
```

默认后端地址：

```text
http://localhost:4173
```

`server.mjs` 会挂载 `dist/`。如果没有构建产物，首页会提示先执行 `npm run build`；`/api/*` 接口仍可用于 GitHub Pages 前后端分离部署。生产构建后资源会带 hash，并由服务端返回长期缓存头；`index.html` 和 `config.js` 保持 `no-cache`，方便改后端地址。

常用环境变量：

```bash
PORT=4173
CORS_ORIGINS=https://你的GitHub用户名.github.io
MAX_ACTIVE_JOBS=2
FETCH_TIMEOUT_MS=20000
JOB_TTL_MS=600000
```

## GitHub Pages + 自己服务器

这是最适合低带宽服务器的方式：GitHub Pages 承担前端静态资源，服务器只跑 API。

1. 推到 GitHub 后，启用 Pages，选择 GitHub Actions。
2. 本仓库已经带 `.github/workflows/pages.yml`，push 到 `main` 会自动构建并发布 `dist/`。
3. 给后端服务器绑定 HTTPS 域名，例如 `https://api.example.com`。
4. 启动后端时设置：

```bash
export PORT=4173
export CORS_ORIGINS=https://你的GitHub用户名.github.io
npm start
```

5. 打开 Pages 页面后，在右上角设置里填 API 地址，或直接用：

```text
https://你的GitHub用户名.github.io/仓库名/?api=https://api.example.com
```

注意：GitHub Pages 是 HTTPS，浏览器会拦截 HTTPS 页面访问普通 `http://服务器IP:4173`。后端必须用 HTTPS 域名。

## Linux 部署参考

安装 Node.js 24 LTS 和 Caddy 后，把项目放到：

```text
/opt/weibo-redpacket-probe
```

构建并安装生产依赖：

```bash
npm ci
npm run build
npm prune --omit=dev
sudo mkdir -p output
sudo chown -R www-data:www-data output
```

复制 systemd 服务：

```bash
sudo cp deploy/weibo-draw.service /etc/systemd/system/weibo-draw.service
sudo systemctl daemon-reload
sudo systemctl enable --now weibo-draw
```

复制 Caddy 配置时，把 `deploy/Caddyfile` 里的域名改成自己的域名：

```bash
sudo caddy validate --config deploy/Caddyfile
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

如果只让 GitHub Pages 放前端，服务器也可以不构建前端，但保留 `dist/` 方便你自己访问同域版本。

## 数据源

- H5 Cookie：默认模式。可粘贴微博网页登录 Cookie；有效 Cookie 会存入本机 `output/auth/weibo-cookie.json`。不填写时会从服务器 Cookie 池找可用项。
- 官方 token：调用微博开放平台 `statuses/repost_timeline`，受账号权限和频次限制。
- 手动导入：粘贴 CSV / TSV / JSON 候选名单，最稳定，也最适合正式开奖前做人工整理。

工具不会绕验证码、不会破解限制；微博接口可能只返回部分可见数据，需在活动规则允许范围内使用。

## 开奖能力

- 按 UID / 昵称去重
- 自动分页抓取可见转发
- 关键词、@ 数、黑名单筛选
- 多奖项逐级开奖
- 公开随机种子 + SHA-256 Fisher-Yates 洗牌
- 候选池摘要、开奖记录图、结果保存
- 候选人和中奖名单 CSV 导出

结果保存到：

```text
output/draws/
```

抽奖开始次数保存到：

```text
output/draw-attempts.jsonl
```

## 红包 H5 探测脚本

这部分保留给兼容性测试：

```bash
npm run login -- --profile profiles/customer-test
npm run probe -- --url "https://你的微博红包链接" --device iphone --profile profiles/customer-test
```

常用参数：

```bash
--url <url>              红包页或红包卡片链接；probe 必填
--device iphone|android  默认 iphone
--profile <dir>          登录态保存目录
--interval-ms <ms>       轮询截图间隔，默认 5000
--max-minutes <n>        最长观察分钟数，默认 10
```

截图和报告会保存在：

```text
output/runs/<timestamp>/
output/login/<timestamp>/
```
