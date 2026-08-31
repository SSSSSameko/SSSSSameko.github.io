# 微博转发抽奖助手

当前版本：`3.1.0`

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
- `PORT=4173`（整数，范围 `1-65535`；环境文件未配置时使用 `4173`）
- `CORS_ORIGINS=https://你的前端域名`（多个来源用逗号分隔，使用 `http://` 或 `https://` 来源格式）
- `API_KEY=可选的公开接口访问密钥`（配置后前端需要在设置中填写）
- `ADMIN_KEY=你的后台密钥`
- `ADMIN_USERNAME=后台账号`（1-64 位，仅限英文字母、数字、点、下划线和连字符）
- `ADMIN_PASSWORD_HASH=scrypt 密码哈希`（安装脚本要求当前生成器格式）
- `ADMIN_SESSION_SECRET=随机会话密钥`（至少 32 字节）
- `COOKIE_WRITE_KEY=仅供服务器 Cookie 池维护使用的独立密钥（通过 x-cookie-write-key 请求头提供，若配置则为 64 位十六进制字符）`
- `SOURCE_FINGERPRINT_SECRET=去标识化来源与登录态指纹密钥（若配置则为 64 位十六进制字符，未配置时复用会话密钥）`
- `PLAYWRIGHT_BROWSERS_PATH=/opt/sameko-weibo-lottery/current/ms-playwright`
- `WEIBO_BROWSER_SANDBOX=1`（生产环境默认开启 Chromium 沙箱；仅在目标主机明确不支持时才设为 `0`）
- `MAX_DRAW_SAVE_BODY_BYTES=2097152`
- `REJECTED_BODY_DRAIN_MS=1000`（拒绝超限请求后最多排空连接的时间，避免慢速请求长期占用）
- `MAX_DRAW_ATTEMPT_BYTES=1048576`（开奖动作日志只保留最新 1 MiB，并按条数和字节双重裁剪）
- `MAX_DRAW_SEQUENCES=5000`（限制长期保留的微博开奖序号账本条目）
- `MAX_SAVED_DRAW_AGE_DAYS=180`
- `MAX_SAVED_DRAW_FILE_BYTES=4194304`（后台单个开奖记录读取上限，防止异常文件造成内存峰值）
- `DRAW_FILE_SCAN_MAX_ENTRIES=5000`（开奖记录目录单轮扫描保护上限）
- `DRAW_RECOVERY_SCAN_MAX_ENTRIES=20000`（普通扫描被截断时的受控恢复上限）
- `DRAW_FILE_SCAN_BUDGET_MS=15000`（单轮开奖记录扫描时间上限）
- `DRAW_CLEANUP_BATCH_SIZE=256`（单轮最多回收的开奖记录文件数）
- `FILE_CLEANUP_CONCURRENCY=8`（文件回收并发上限）
- `MAX_FEEDBACK_AGE_DAYS=90`
- `MAX_CORRUPT_JSON_BACKUPS=6`（每个存储文件最多保留的损坏副本数）
- `MAX_CANDIDATES=20000`（单次任务的容量上限，不代表微博一定能返回这么多可见转发）
- `MAX_ACCESS_TOKEN_BYTES=1024`（官方接口访问凭据的单字段长度上限，最多可配置为 8192 字节）
- `MAX_CANDIDATE_PAYLOAD_BYTES=16777216`（候选聚合数据的内存上限）
- `MAX_CLIENT_REPOST_JOBS=2`（同一来源最多同时运行或排队的抓取任务）
- `MAX_RETAINED_JOBS=4`（限制已完成任务在内存中的短时暂存数量）
- `MAX_RETAINED_JOB_RESPONSE_BYTES=33554432`（限制已完成响应的合计暂存体积）
- `MAX_JOB_SUBSCRIBERS=32`（限制同一抓取任务的并发页面订阅数）
- `DESKTOP_MAX_PAGES=1000`
- `PAGE_DELAY_JITTER_MS=1500`
- `PAGE_COOLDOWN_EVERY=8`
- `PAGE_COOLDOWN_MS=5000`
- `WEIBO_THROTTLE_RETRY_MAX=2`
- `REPOST_SNAPSHOT_TTL_MS=15000`（仅复用刚完成的短时结果）
- `MAX_REPOST_SNAPSHOTS=2`
- `RUNTIME_CACHE_MAX_BYTES=67108864`（只回收可再生成的浏览器缓存，不清理登录 Profile）
- `RUNTIME_CACHE_MAX_AGE_DAYS=30`
- `WEIBO_BROWSER_DISK_CACHE_BYTES=33554432`
- `WEIBO_BROWSER_MEDIA_CACHE_BYTES=8388608`
- `SERVICE_MEMORY_HIGH_MB=700`（同步设置应用诊断阈值和 systemd `MemoryHigh`）
- `SERVICE_MEMORY_MAX_MB=850`（同步设置应用诊断上限和 systemd `MemoryMax`）
- `SERVICE_RECYCLE_INTERVAL_MS=86400000`（同步设置应用显示的回收周期和 systemd `RuntimeMaxSec`）
- `FEEDBACK_SOURCE_DAILY_MAX=12`
- `FEEDBACK_GLOBAL_HOURLY_MAX=120`

生产环境必须使用至少 32 字节的 `ADMIN_SESSION_SECRET`。`COOKIE_WRITE_KEY` 未配置时，公开抓取请求无法写入或校验服务器 Cookie 池；配置时使用 64 位十六进制字符。`SOURCE_FINGERPRINT_SECRET` 未配置时复用 `ADMIN_SESSION_SECRET`，配置时使用 64 位十六进制字符。服务器登录态不可用时才会尝试用户填写的备用 Cookie，该内容仅用于当前任务。

分页抓取会在每页之间随机等待，并按固定页数进行额外冷却。主入口返回不完整时会继续通过备用入口补齐并按转发记录去重；连续空页会提前停止，避免无效请求。较长的任务结束前会补查最新一页，合并抓取期间刚出现的转发；同一微博的并发请求会共享任务。遇到微博 `418`、`429` 或临时 `503` 时，服务会尊重 `Retry-After` 并退避重试。候选数硬上限为 20,000，极端长文本名单还会受总数据体积限制；实际候选数量仍取决于微博接口可见范围、账号权限和接口返回的最大页数。

运行数据保存在 `output/`，浏览器登录资料保存在 `output/auth/weibo-login-profile/`。Chromium 的网络和媒体缓存写入 `output/runtime-cache/` 并定期回收；旧 Profile 中的 `Cache`、`Code Cache` 和着色器缓存也会清理，但不会删除 Cookies、Local Storage、IndexedDB 等登录资料。这些目录不提交到 Git。

## 后台管理

后端部署完成后访问：

```text
https://你的后端地址/admin
```

使用服务器配置的账号和密码登录。`ADMIN_KEY` 仅保留给接口运维调用，不会显示在登录页。后台可以查看开奖记录、中奖明细、用户反馈、抓取队列、内存趋势和 Cookie 保活状态；反馈可以标记处理或删除。

## 服务器安装

Ubuntu 服务器将仓库检出到 `/opt/sameko-weibo-lottery` 后运行：

```bash
sudo bash deploy/install.sh
```

脚本默认要求源码是干净的 Git 仓库根目录，并从当前 commit 直接生成发布归档；commit 会写入发布目录，未提交文件不会进入服务器版本。随后在独立目录中安装锁定依赖、构建前端并安装 Playwright Chromium，再把完整版本放入 `releases/`，通过 `current` 符号链接一次切换前后端。健康检查失败时会恢复上一版本和原 systemd 配置；恢复不完整时会保留备份供人工处理。最近两个旧版本会继续保留。若源码不在应用目录，可通过 `SOURCE_DIR=/path/to/source` 指定来源；只有经过单独校验的离线归档才应设置 `ALLOW_UNVERSIONED_SOURCE=1`。

首次运行会要求输入后台账号和密码，并在权限为 `0600` 的 `/etc/sameko-weibo-lottery.env` 中生成密码哈希、三个 32 字节十六进制密钥和默认 CORS 来源。再次运行会保留并校验该文件；配置不合法时不会停止服务。环境文件中的服务回收周期和内存阈值会同步到 systemd；`NODE_OPTIONS`、`HOST`、`HOME` 和 Playwright 路径等运行约束由服务固定管理，不允许在该文件中覆盖。

服务器需要预先安装受支持的 Node.js、npm、Git、tar、OpenSSL、GNU coreutils 和 systemd。部署更新前应先运行 `npm run test:release`；systemd 仍按 24 小时周期回收服务进程，避免小内存服务器长期积累不可回收资源。

`deploy/Caddyfile` 是反向代理模板，不会由安装脚本覆盖现有站点配置。启用后台或备用 Cookie 前，应将模板按实际域名或 IP 合并到 `/etc/caddy/Caddyfile`；如果修改了应用的 `PORT`，也要同步修改 `reverse_proxy` 的端口。HTTP 只保留证书验证入口，其余请求跳转 HTTPS，并在 HTTPS 响应中启用 HSTS。修改后运行：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

依赖版本变更后运行 `npm run licenses`，同步更新 `THIRD_PARTY_NOTICES.md` 和前端可查看的完整许可文本。普通构建不会改写已审核的许可清单。

视觉资产记录见 `docs/ASSET-NOTICES.md`。

版本记录：见 `docs/CHANGELOG.md`；站内可从“更多 → 关于此应用 → 更新日志”查看。
