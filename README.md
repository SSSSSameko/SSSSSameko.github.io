# 微博转发抽奖助手

当前版本：`3.6.1`（2026 年 11 月 5 日）

用于微博转发抽奖的网页工具，支持候选抓取、名单导入、滚动开奖、开奖记录图和后台管理。

## 功能

- 微博可见转发候选抓取
- 手动名单导入
- 自定义奖项和名额
- 同一用户每轮最多中奖一次；关闭候选去重时，每条转发仍参与抽取
- 滚动开奖动画
- 开奖记录图、CSV 导出
- 后台开奖记录管理
- 服务器 Cookie 池、扫码登录和自动保活
- 抓取队列、接口限流和分页延迟

## iPhone 与全屏显示

在“更多”中打开“添加到主屏幕”，按照说明从 Safari 分享菜单添加网站；若出现
“作为网页 App 打开”，保持开启。之后从主屏幕图标进入即可使用无浏览器工具栏的独立窗口。
iPhone Safari 普通标签页不支持网站强制隐藏地址栏；支持全屏的浏览器会显示“全屏显示 / 退出全屏”。

独立窗口的本机记录可能与浏览器分开保存，切换前可在数据设置中导出重要记录。
此功能不提供离线抓取，载入微博与保存服务器记录仍需联网。

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

开发界面时保留后端运行，在另一个终端执行 `npm run dev`。开发服务会把 `/api`
请求转发到 `http://127.0.0.1:4173`；后端使用其他端口时，通过 `DEV_API_TARGET`
指定地址，例如 PowerShell 中先执行 `$env:DEV_API_TARGET='http://127.0.0.1:4180'`。
后端未启动时，设置页会显示连接失败提示。

## 配置

前端可托管到 GitHub Pages，后端部署到服务器。公开前端通过 `static/config.js` 指向后端 API。

`static/config.js` 的工程检查要求填写运营者名称/姓名和有效联系渠道；其余字段在检查中可选，不代表依法无需披露。留空时使用前端内置默认文案，不会读取服务器实际运行参数。当前地域说明依据运营者确认的「GitHub Pages 静态前端 + 美国怀俄明州后端」编写，接收方、保存规则与备份仍须按实际部署核实；变化时必须同步更新。配置示例：

```js
window.WEIBO_DRAW_LEGAL = window.WEIBO_DRAW_LEGAL || {
  operatorName: 'Sameko',                 // 当前署名；需核实是否满足适用的主体披露要求
  privacyContact: 'loveofcc@gmail.com',   // 必填：长期有效的联系邮箱
  // 以下为工程可选字段，留空使用前端默认文案；部署变化时须人工同步
  operatorAddress: '',
  hostingProvider: '',                      // 如“自建机房”“Vultr”
  serverRegion: '美国怀俄明州',
  dataRecipientDisclosure: '',
  jurisdictionDisclosure: '',
  recordRetentionDisclosure: '',
  credentialRetentionDisclosure: '',
};
```

可先运行 `npm run legal:check`；正式安装脚本也会执行同一校验，必填项为空或任何已填字段仍是占位内容时拒绝部署。该工程校验只能防止遗漏，不构成法律意见。

前端默认不显示预置后端地址，设置页只保留自行填写入口；浏览器仍需在请求层访问真实接口，因此不能通过前端代码隐藏网络目标。正式部署建议使用独立域名和 HTTPS，不要把裸 IP 当作长期公开入口。

常用环境变量：

- `HOST=127.0.0.1`
- `PORT=4173`（整数，范围 `1-65535`；环境文件未配置时使用 `4173`）
- `CORS_ORIGINS=https://你的前端域名`（多个来源用逗号分隔，使用 `http://` 或 `https://` 来源格式）
- `ALLOW_PUBLIC_API=1`（安装脚本为新部署默认写入 `1`：公开静态前端无法保存共享密钥，匿名开放抓取与开奖记录接口，由限流、任务队列和容量上限兜底。即使服务只绑定 `127.0.0.1`、由反向代理对外提供，也必须显式设置）
- `API_KEY=公开业务接口的共享访问密钥`（可选，至少 32 字节；只在需要额外访问门槛时配置。前端能读取到的密钥就不是保密凭据，它只能挡掉顺手抓接口的人，无法阻止有意滥用。配置后所有前端分发渠道都必须同步同一个值，否则访客会收到 401）
- `ADMIN_KEY=你的后台密钥`（可选；生产环境或非回环监听时如配置，至少 32 字节）
- `ADMIN_USERNAME=后台账号`（1-64 位，仅限英文字母、数字、点、下划线和连字符）
- `ADMIN_PASSWORD_HASH=scrypt 密码哈希`（安装脚本要求当前生成器格式）
- `ADMIN_SESSION_SECRET=随机会话密钥`（至少 32 字节）
- `COOKIE_WRITE_KEY=仅供服务器 Cookie 池维护使用的独立密钥（通过 x-cookie-write-key 请求头提供，若配置则为 64 位十六进制字符）`
- `ENABLE_COOKIE_READ_API=1`（安装脚本为新部署默认写入 `1`，开启只读 `GET /v1/cookie/current`；改为 `0` 或删除该行即关闭并返回 404）
- `COOKIE_READ_KEY=只读 Cookie 接口的专用密钥`（安装脚本为新部署自动生成 64 位十六进制字符，且必须与 `API_KEY`、`ADMIN_KEY` 不同。只接受 `x-cookie-read-key` 或 `Authorization: Bearer`，不读取 `x-api-key`；未配置时仅允许回环来源）
- `COOKIE_READ_AUDIT_INTERVAL_MS=21600000`（可选；同一来源的只读接口成功审计最短合并间隔，默认 6 小时，避免高频轮询挤掉其他安全事件）
- `ADMIN_BASE_PATH=/admin`（可选；后台入口路径。默认 `/admin`，改成例如 `/ops-9d2c` 之类不好猜的路径可以减少被扫描到后台页面的机会；必须以 `/` 开头，不能占用 `/api`、`/v1`。改完记得同步书签和部署自检。前端页面不链接后台入口，也不显示真实后端地址）
- `SOURCE_FINGERPRINT_SECRET=去标识化来源与登录态指纹密钥（若配置则为 64 位十六进制字符，未配置时复用会话密钥）`
- `EDGE_ACCESS_LOG_PATH=/var/log/caddy/sameko-access.log`（可选；Caddy 等边缘代理的 JSON 访问日志路径。配置后后台“安全提醒”会统计代理在应用之前直接拒绝的扫描请求；只按状态、路径和脱敏来源聚合，不保存原始 IP 和查询参数。未配置时后台显示“未启用”，不影响其他功能）
- `SECURITY_SIGNAL_THRESHOLD=8`（可选；同一类可疑行为在统计窗口内达到多少次后生成后台风险提醒，默认 8 次）
- `SECURITY_SIGNAL_WINDOW_MS=600000`（可选；风险提醒的统计窗口，默认 10 分钟）
- `AVATAR_MISS_CACHE_TTL_MS=600000`（可选；源头像返回 404 后的短时负缓存，默认 10 分钟，减少重复上游请求）
- `AVATAR_MISS_CACHE_MAX_ENTRIES=512`（可选；头像 404 负缓存的最多条目数）
- `PLAYWRIGHT_BROWSERS_PATH=/opt/sameko-weibo-lottery/current/ms-playwright`
- `WEIBO_BROWSER_SANDBOX=1`（生产环境默认开启 Chromium 沙箱；仅在目标主机明确不支持时才设为 `0`）
- `MAX_DRAW_SAVE_BODY_BYTES=2097152`
- `REJECTED_BODY_DRAIN_MS=1000`（拒绝超限请求后最多排空连接的时间，避免慢速请求长期占用）
- `MAX_DRAW_ATTEMPT_BYTES=1048576`（开奖动作日志只保留最新 1 MiB，并按条数和字节双重裁剪）
- `MAX_DRAW_SEQUENCES=5000`（限制长期保留的微博开奖序号账本条目）
- `MAX_SAVED_DRAW_AGE_DAYS=0`（默认 0，表示关闭按时间清理；如需启用可配置 1-180 天，数量与容量清理不受影响）
- `DRAW_RETENTION_GRACE_DAYS=30`（首次启用或缩短保留期限时，按时间清理的启用宽限；服务端上限为 30 天，数量与容量清理不暂停）
- `MAX_SAVED_DRAW_FILE_BYTES=4194304`（后台单个开奖记录读取上限，防止异常文件造成内存峰值）
- `DRAW_FILE_SCAN_MAX_ENTRIES=5000`（开奖记录目录单轮扫描保护上限）
- `DRAW_RECOVERY_SCAN_MAX_ENTRIES=20000`（普通扫描被截断时的受控恢复上限）
- `DRAW_FILE_SCAN_BUDGET_MS=15000`（单轮开奖记录扫描时间上限）
- `DRAW_CLEANUP_BATCH_SIZE=256`（单轮最多回收的开奖记录文件数）
- `FILE_CLEANUP_CONCURRENCY=8`（文件回收并发上限）
- `MAX_FEEDBACK_AGE_DAYS=90`（服务端硬上限为 90 天）
- `MAX_CORRUPT_JSON_BACKUPS=6`（每个存储文件最多保留的损坏副本数）
- `MAX_CORRUPT_JSON_BACKUP_AGE_DAYS=30`（损坏副本的最长保留期，服务端硬上限为 30 天）
- `MAX_CANDIDATES=20000`（单次任务的容量上限，不代表微博一定能返回这么多可见转发）
- `MAX_ACCESS_TOKEN_BYTES=1024`（官方接口访问凭据的单字段长度上限，最多可配置为 8192 字节）
- `MAX_CANDIDATE_PAYLOAD_BYTES=16777216`（候选聚合数据的内存上限）
- `MAX_CLIENT_REPOST_JOBS=4`（同一来源最多同时运行或排队的抓取任务）
- `MAX_RETAINED_JOBS=8`（限制已完成任务在内存中的短时暂存数量）
- `MAX_RETAINED_JOB_RESPONSE_BYTES=33554432`（限制已完成响应的合计暂存体积）
- `MAX_JOB_SUBSCRIBERS=32`（限制同一抓取任务的并发页面订阅数）
- `DESKTOP_MAX_PAGES=1000`
- `PAGE_DELAY_JITTER_MS=1000`（官方接口分页和入口切换等待的随机抖动）
- `PROVIDER_SWITCH_DELAY_MS=8000`（桌面端、H5、旧版页面之间切换入口的基准等待，连同抖动后为 8-9 秒）
- `OFFICIAL_PAGE_DELAY_MS=6000`
- `DESKTOP_PAGE_DELAY_MS=400`、`DESKTOP_PAGE_DELAY_JITTER_MS=300`（桌面端每页实际等待 400-700ms）
- `LEGACY_PAGE_DELAY_MS=6000`
- `LEGACY_PAGE_DELAY_JITTER_MS=1000`（旧版页面每页实际等待 6-7 秒）
- `MOBILE_PAGE_DELAY_MS=800`、`MOBILE_PAGE_DELAY_JITTER_MS=800`（H5 每页实际等待 800-1600ms）
- `PAGE_COOLDOWN_EVERY=8`
- `PAGE_COOLDOWN_MS=5000`
- `WEIBO_THROTTLE_RETRY_MAX=2`
- `MAX_CONNECTIONS=512`（单进程最大并发连接数）
- `MAX_REQUESTS_PER_SOCKET=200`（单个长连接最多复用的请求数）
- `REPOST_SNAPSHOT_TTL_MS=15000`（仅复用刚完成的短时结果）
- `MAX_REPOST_SNAPSHOTS=2`
- `RUNTIME_CACHE_MAX_BYTES=67108864`（只回收可再生成的浏览器缓存，不清理登录 Profile）
- `RUNTIME_CACHE_MAX_AGE_DAYS=30`
- `WEIBO_BROWSER_DISK_CACHE_BYTES=33554432`
- `WEIBO_BROWSER_MEDIA_CACHE_BYTES=8388608`
- `SERVICE_MEMORY_HIGH_MB=700`（同步设置应用诊断阈值和 systemd `MemoryHigh`）
- `SERVICE_MEMORY_MAX_MB=850`（同步设置应用诊断上限和 systemd `MemoryMax`）
- `SERVICE_RECYCLE_INTERVAL_MS=86400000`（同步设置应用显示的回收周期和 systemd `RuntimeMaxSec`）
- `FEEDBACK_SOURCE_DAILY_MAX=30`
- `FEEDBACK_GLOBAL_HOURLY_MAX=120`

生产环境必须使用至少 32 字节的 `ADMIN_SESSION_SECRET`。`COOKIE_WRITE_KEY` 未配置时，公开抓取请求无法写入或校验服务器 Cookie 池；配置时使用 64 位十六进制字符。`SOURCE_FINGERPRINT_SECRET` 未配置时复用 `ADMIN_SESSION_SECRET`，配置时使用 64 位十六进制字符。服务器登录态不可用时才会尝试用户填写的备用 Cookie，该内容仅用于当前任务。

抓取默认从桌面端开始，每页等待 400-700ms；需要补抓时切到 H5，每页等待 800-1600ms；仍需补抓时再切到旧版页面，每页等待 6-7 秒。入口之间等待 8-9 秒。延迟包含随机抖动，可降低请求频率，但不保证避免上游风控；自定义环境变量会覆盖默认值，部署时需同时核对 systemd 配置。

补抓停止规则与名单完整性分开：总数小于 200 时保留 `max(2, ceil(总数 × 10%))` 的基础容差；总数至少 200 时，在正常扫描结束后允许 `ceil(总数 × 20%)` 的缺口。返回 0 条且总数大于 0、明确分页失败都不能按比例豁免。20% 大名单容差也不适用于页数上限、连续空页或重复页保护、入口错误、末页复核失败等情况。小名单如果桌面和 H5 正常扫完、总数一致且稳定、候选集合相同、去重后新增为 0，可在缺口同时不超过 20%（向下取整）和 10 条时跳过第三入口。不同数量或集合不能凭“看起来差不多”跳过。

达到容差仅停止自动补抓，`complete` 仍为 `false`，前端和开奖确认页会显示实际数量与缺口；只有已知总数达到、未触及资源上限且标识可核对时才标为数量完整。总数未知时以实际非空候选结束扫描，但不声明完整。旧版 BID 与桌面 MID 先统一再去重，同一用户的不同转发仍保留；缺少或无法确定标识格式的条目会标记去重不确定。较长任务结束前补查最新一页；同一微博的并发请求共享任务。限流仍按原有有界退避策略处理。候选数硬上限为 20,000，极端长文本名单还受总数据体积限制；实际数量取决于微博可见范围、账号权限和分页返回。

运行数据保存在 `output/`，浏览器登录资料保存在 `output/auth/weibo-login-profile/`。Chromium 的网络和媒体缓存写入 `output/runtime-cache/` 并定期回收；旧 Profile 中的 `Cache`、`Code Cache` 和着色器缓存也会清理，但不会删除 Cookies、Local Storage、IndexedDB 等登录资料。这些目录不提交到 Git。

## 后台管理

后端部署完成后访问：

```text
https://你的后端地址/admin
```

使用服务器配置的账号和密码登录。`ADMIN_KEY` 仅保留给接口运维调用，不会显示在登录页。后台可以查看开奖记录、中奖明细、用户反馈、抓取队列、内存趋势和 Cookie 保活状态；反馈可以标记处理或删除。

“系统”页把运行异常按分类、级别和错误码聚合展示：接口请求、登录鉴权、安全防护、微博抓取、Cookie 与登录态、浏览器、抓取任务、存储、开奖记录、用户反馈、后台和服务运行各自独立计数。404 路由缺失、已知扫描路径和源头像缺失单列，不再拉高业务错误率；重复扫描只聚合计数，不灌满最近事件。诊断事件在内存中有界保留，按来源和错误码限频去重；微博抓取、Cookie 失效、后台事件写入失败等非 HTTP 故障也会进入同一份统计。达到阈值的可疑行为（扫描探测、后台登录失败、接口限流、畸形请求、上游失败）会在“安全提醒”里汇总，并附上脱敏后的来源指纹。

后台真实入口被自定义后，默认 `/admin` 只会作为无内容的诱捕入口返回 404，不会回退到首页或暴露后台资源。Caddy 模板会提前拒绝常见环境文件、PHP/PHPUnit 漏洞链和其他扫描路径；这只做明确无效路径的诱捕与拦截，不返回伪造的敏感文件或登录凭据。

## 只读 Cookie 接口

微博 Cookie 没有 refresh token，其他项目无法自行续期。安装脚本会为新部署默认生成独立密钥并开启该接口；升级已有部署时，若 `/etc/sameko-weibo-lottery.env` 里还没有这两行，可手动追加后重启服务：

把 `docs/COOKIE-API-CLIENT.md` 整份发给接收方项目（或它的 AI 助手），对方即可按接口契约、示例代码和失败处理接入。

```bash
COOKIE_READ_KEY=$(openssl rand -hex 32)
printf 'ENABLE_COOKIE_READ_API=1\nCOOKIE_READ_KEY=%s\n' "${COOKIE_READ_KEY}" >> /etc/sameko-weibo-lottery.env
systemctl restart sameko-weibo-lottery
```

不再需要时，把 `ENABLE_COOKIE_READ_API` 改为 `0` 并重启服务即可。

调用方式：

```bash
curl -H "x-cookie-read-key: ${COOKIE_READ_KEY}" https://你的后端地址/v1/cookie/current
# 也可以使用 Authorization: Bearer ${COOKIE_READ_KEY}
```

成功返回 `{"ok":true,"cookie":"SUB=...","savedAt":"...","lastValidAt":"...","quarantined":false}`。存储中没有任何登录态时返回 `503`；仅当全部登录态都处于临时隔离期时仍返回 `200`，但 `quarantined` 为 `true`，调用方应把它视为可能失效。对外或非回环调用必须配置独立的 `COOKIE_READ_KEY`，它不会接受前端用户共享的 `API_KEY`，非回环来源还必须通过 HTTPS，未配置 `COOKIE_READ_KEY` 时仅允许服务器本机回环调用。响应不缓存并写入后台审计事件，审计与日志不会记录 Cookie 内容。该响应等同于微博登录态，任何持有者都可能以该账号身份操作；开启后应把接收该登录态的服务列入 `dataRecipientDisclosure`，只提供给可信服务，并按需定期轮询（建议间隔不低于 5 分钟），在泄漏时立即重新登录使旧 Cookie 失效。

## 服务器安装

Ubuntu 服务器将仓库检出到 `/opt/sameko-weibo-lottery` 后运行：

```bash
sudo bash deploy/install.sh
```

脚本默认要求源码是干净的 Git 仓库根目录，并从当前 commit 直接生成发布归档；commit 会写入发布目录，未提交文件不会进入服务器版本。随后在独立目录中安装锁定依赖、构建前端并安装 Playwright Chromium，再把完整版本放入 `releases/`，通过 `current` 符号链接一次切换前后端。健康检查失败时会恢复上一版本和原 systemd 配置；恢复不完整时会保留备份供人工处理。最近两个旧版本会继续保留。若源码不在应用目录，可通过 `SOURCE_DIR=/path/to/source` 指定来源；只有经过单独校验的离线归档才应设置 `ALLOW_UNVERSIONED_SOURCE=1`。

首次运行会要求输入后台账号和密码，并在权限为 `0600` 的 `/etc/sameko-weibo-lottery.env` 中生成密码哈希、三个服务端密钥、默认 CORS 来源和 `ALLOW_PUBLIC_API=1`。默认不生成 `API_KEY`：公开静态前端拿不到也藏不住它，自动生成只会让整站请求 401。需要访问门槛时再显式填写 `API_KEY`，并把同一个值配置到所有前端分发渠道。再次运行会保留并校验该文件；既没有 `API_KEY`、也没有显式设置 `ALLOW_PUBLIC_API=1` 的旧配置会被拒绝，避免反向代理下意外公开业务接口。环境文件中的服务回收周期和内存阈值会同步到 systemd；`NODE_OPTIONS`、`HOST`、`HOME` 和 Playwright 路径等运行约束由服务固定管理，不允许在该文件中覆盖。

服务器需要预先安装受支持的 Node.js、npm、Git、tar、OpenSSL、GNU coreutils 和 systemd。部署更新前应先运行 `npm run test:release`；systemd 仍按 24 小时周期回收服务进程，避免小内存服务器长期积累不可回收资源。

`deploy/Caddyfile` 是反向代理模板，不会由安装脚本覆盖现有站点配置。启用后台或备用 Cookie 前，应将模板按实际域名或 IP 合并到 `/etc/caddy/Caddyfile`；如果修改了应用的 `PORT`，也要同步修改 `reverse_proxy` 的端口。HTTP 只保留证书验证入口，其余请求跳转 HTTPS，并在 HTTPS 响应中启用 HSTS。修改后运行：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

模板里的 `log` 指令会让 Caddy 把 JSON 访问日志写入 `/var/log/caddy/sameko-access.log`（10 MB 轮转、保留 3 份、权限 `0644`）。日志会删除 `Authorization`、Cookie、API Key、后台 CSRF 和任务令牌等敏感请求头；服务以 `www-data` 运行，只需要该文件的读权限，日志目录建议保持 `0755`。如果日志文件不可读，后台只会显示“边缘代理拦截：读取失败”，业务功能不受影响。

生产环境应只开放 `22`、`80`、`443`，不要直接暴露应用端口。Caddy 模板会在应用前拦截常见环境文件、管理端点和扫描路径；更稳妥的部署方式是在 Caddy 前接入 Cloudflare 代理和免费 WAF，并把源站防火墙限制为只接受 Cloudflare 回源。后台使用随机 `ADMIN_BASE_PATH`、强密码和仅密钥 SSH，不要为了消除扫描器的 404 而创建 `.env`、`actuator`、`mcp` 等路径。

`deploy/fail2ban/` 提供可选的 Caddy 扫描封禁规则。复制到服务器后只统计明确的漏洞扫描路径，不会因为普通 404 或头像缺失封禁访客：

```bash
sudo install -m 0644 deploy/fail2ban/sameko-caddy.conf /etc/fail2ban/filter.d/sameko-caddy.conf
sudo install -m 0644 deploy/fail2ban/sameko-caddy.local /etc/fail2ban/jail.d/sameko-caddy.local
sudo fail2ban-client -t
sudo systemctl reload fail2ban
sudo fail2ban-client status sameko-caddy
```

默认在一个统计窗口内命中 6 次扫描特征后封禁 2 小时，重复违规会按 `fail2ban` 的递增策略延长，最长 1 周。规则使用“全端口封禁”动作，因此已被确认扫描的 IP 也无法继续访问 SSH；不要把它改成仅按普通 404 状态计数。

依赖版本或发布平台变更后运行 `npm run licenses`，按当前环境实际安装的 npm 包同步更新 `THIRD_PARTY_NOTICES.md` 和前端可查看的许可文本；已安装的平台 optional 包会纳入，未安装的平台包会跳过。部署脚本会在 Linux 发布 stage 内安装 Chromium 后重新生成清单，并检查浏览器目录至少带有许可或复制声明；该工程检查不等于对 Chromium/Playwright 全部再分发义务的法律结论。普通构建不会改写已审核的许可清单。

视觉资产记录见 `docs/ASSET-NOTICES.md`，本轮法律与许可审查见 [审查记录](docs/LEGAL-REVIEW-2026-11-05.md)。当前用途为个人免费运营，供美国与中国大陆的受邀请朋友内部测试；用途说明不构成技术访问控制，也不自动免除个人信息或素材权利义务。`static/config.js` 应披露真实的个人信息处理者名称或姓名和有效联系渠道；工程检查只核验字段格式和明显占位文本，不验证身份、事实或法律合规。当前 `Sameko` / `by.sameko` 是署名，是否满足适用的主体披露要求仍需核实。可选字段留空时使用前端内置文案，不会读取后端环境变量或自动同步实际保存规则；托管商、接收方、保存期限、备份及跨境安排均须按实际部署核实并人工更新。使用、展示或分发头像、图片、字体等素材前，应确认相应权利依据；无法确认时应停止使用并替换。

版本记录统一维护在 `docs/CHANGELOG.md`，新版本追加在文件末尾；站内“更新日志”和后端版本信息均由该文件生成。格式为「## 版本号 · 发布日期」，下接一句话标题和若干短条目，一律从使用者视角描述能感知到的变化，不写内部实现、文件名、函数名或安全细节。每次发布必须同步提升 `package.json` 版本号，并让更新日志最后一条与包版本一致；构建和服务启动都会校验，不一致时直接失败。

Cookie 抓取某一页遇到临时上游故障时，会保留此前候选，说明失败页码后继续尝试备用入口；登录失效、限流和取消仍按原流程处理。H5 的“还没有人转发过”仅代表该入口没有可见记录，不会把其他入口的已知总数清零。后台对每个入口记录 `provider-result` / `provider-error`，包含返回数、实际新增、重复数、累计缺口、页数、起止时间和停止原因；最终 `load-result` 用 `crawlId` 与渠道事件关联，用 `jobId` 与任务关联。达到资源上限而未处理完条目时，重复数记为未知，避免把未处理条目误报为重复。成功与部分结果都保留计数，便于判断补抓是否有收益，不写入候选个人信息或凭据。

官方令牌入口独立运行，不切换 Cookie 渠道。后续分页遇到可恢复的上游故障时保留此前名单并提示失败页；总数未知时按分页结束条件读取，且不声明完整。所有来源的未知总数都会在名单和开奖确认页提示。保存的开奖记录保留名单载入时间与来源计数；上游总数可能滞后于实际条目，不据此拒绝保存。最后一次上线前审查与验证范围见 [审查记录](docs/PRELAUNCH-REVIEW-2026-11-05.md)。

## 代码结构

源码职责、模块边界和测试组织见 [代码结构与开发约定](docs/ARCHITECTURE.md)。
