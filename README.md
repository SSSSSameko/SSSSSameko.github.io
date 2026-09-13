# 微博转发抽奖助手

当前版本：`3.5.0`（2026 年 9 月 13 日）

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

公开部署前只需要在 `static/config.js` 填写两项：运营者署名和一条长期有效的联系邮箱。地址、托管服务商、机房区域和保存规则都是选填，留空时按程序的实际运行参数自动生成。当前部署按「GitHub Pages 静态前端 + 美国怀俄明州自建后端」填写接收方与地域说明；更换服务器或托管方式时必须同步覆盖。示例：

```js
window.WEIBO_DRAW_LEGAL = window.WEIBO_DRAW_LEGAL || {
  operatorName: 'Sameko',                 // 必填：运营者署名
  privacyContact: 'loveofcc@gmail.com',   // 必填：长期有效的联系邮箱
  // 以下均选填，留空时由程序生成；与实际部署不符时再覆盖
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
- `PAGE_DELAY_JITTER_MS=1000`（分页等待在基准值上增加 0-1 秒随机抖动）
- `PROVIDER_SWITCH_DELAY_MS=6000`（桌面端、H5、旧版页面之间切换入口的基准等待，连同抖动后为 6-7 秒）
- `OFFICIAL_PAGE_DELAY_MS=6000`
- `DESKTOP_PAGE_DELAY_MS=6000`
- `LEGACY_PAGE_DELAY_MS=6000`
- `MOBILE_PAGE_DELAY_MS=6000`
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
- `FEEDBACK_SOURCE_DAILY_MAX=30`
- `FEEDBACK_GLOBAL_HOURLY_MAX=120`

生产环境必须使用至少 32 字节的 `ADMIN_SESSION_SECRET`。`COOKIE_WRITE_KEY` 未配置时，公开抓取请求无法写入或校验服务器 Cookie 池；配置时使用 64 位十六进制字符。`SOURCE_FINGERPRINT_SECRET` 未配置时复用 `ADMIN_SESSION_SECRET`，配置时使用 64 位十六进制字符。服务器登录态不可用时才会尝试用户填写的备用 Cookie，该内容仅用于当前任务。

分页抓取会在每页之间以及切换桌面端、H5、旧版入口之间随机等待 6-7 秒，并按固定页数进行额外冷却。主入口到达接口声明的最后一页后会直接采用其结果；微博统计总数与可见候选数不一致时只提示差额，不再为此重复轮询其他入口。只有分页未完成、连续空页或接口失败时才继续通过备用入口补齐并按转发记录去重。较长的任务结束前会补查最新一页，合并抓取期间刚出现的转发；同一微博的并发请求会共享任务。遇到微博 `418`、`429` 或临时 `503` 时，服务会尊重 `Retry-After` 并退避重试。候选数硬上限为 20,000，极端长文本名单还会受总数据体积限制；实际候选数量仍取决于微博接口可见范围、账号权限和接口返回的最大页数。

运行数据保存在 `output/`，浏览器登录资料保存在 `output/auth/weibo-login-profile/`。Chromium 的网络和媒体缓存写入 `output/runtime-cache/` 并定期回收；旧 Profile 中的 `Cache`、`Code Cache` 和着色器缓存也会清理，但不会删除 Cookies、Local Storage、IndexedDB 等登录资料。这些目录不提交到 Git。

## 后台管理

后端部署完成后访问：

```text
https://你的后端地址/admin
```

使用服务器配置的账号和密码登录。`ADMIN_KEY` 仅保留给接口运维调用，不会显示在登录页。后台可以查看开奖记录、中奖明细、用户反馈、抓取队列、内存趋势和 Cookie 保活状态；反馈可以标记处理或删除。

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

依赖版本或发布平台变更后运行 `npm run licenses`，按当前环境实际安装的 npm 包同步更新 `THIRD_PARTY_NOTICES.md` 和前端可查看的许可文本；已安装的平台 optional 包会纳入，未安装的平台包会跳过。部署脚本会在 Linux 发布 stage 内安装 Chromium 后重新生成清单，并检查浏览器目录至少带有许可或复制声明；该工程检查不等于对 Chromium/Playwright 全部再分发义务的法律结论。普通构建不会改写已审核的许可清单。

视觉资产记录见 `docs/ASSET-NOTICES.md`。正式公开部署前，必须在 `static/config.js` 中补充真实的个人信息处理者名称或姓名和一条长期有效的联系渠道；部署脚本会对这两项必填字段以及所有已填字段执行长度、控制字符和明显占位文本检查，但该工程门禁不等于法律合规认证。地址、托管服务商、服务器区域、接收方、保存期限、备份和跨境说明默认按程序实际运行参数生成，应与实际部署逐一核对，不一致时必须覆盖。还必须逐项确认头像、偶像图片、字体及其他素材的展示、复制、传播和必要改编授权；当前页面的 `by.sameko` 仅是产品标识，不是完整的法定主体信息。

版本记录：见 `docs/CHANGELOG.md`；站内可从“更多 → 关于此应用 → 更新日志”查看。格式为「## 版本号 · 发布日期」，下接一句话标题和若干短条目，一律从使用者视角描述能感知到的变化，不写内部实现、文件名、函数名或安全细节。新版本追加在文件末尾，并同步 `src/data/legalDocuments.js` 的 `UPDATE_LOGS`：最新一条 `label` 为 `当前版本`，其余为 `历史版本`。
