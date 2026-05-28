# 微博转发抽奖助手安全审查

审查时间：2026-05-29

## 总结

项目没有发现“通过前端直接读出服务器 Cookie 明文”的接口；`/api/weibo/cookie-status` 只返回数量、状态和时间，不返回 Cookie 内容。主要风险不是“被网页直接盗 Cookie”，而是如果后端 API 暴露到公网且没有认证，别人可以绕过浏览器 CORS，用脚本直接调用你的服务器，消耗服务器流量、创建抓取任务、使用服务器 Cookie 池请求微博接口。

本次已做基础加固：

- 增加可选 `API_KEY` 后端保护。
- 前端设置面板增加 `API Key` 输入，Key 只保存在本机浏览器 localStorage，不写入 GitHub。
- CORS 允许 `x-api-key` 请求头。
- 增加基础 API 频率限制。
- Cookie 存储文件写入时尽量设置为 `0600`，目录为 `0700`。
- 响应增加 `nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer` 等基础安全头。

## 高风险

### S1. 后端 API 原先没有身份认证

位置：

- `server.mjs` 的 `/api/weibo/reposts/jobs`
- `server.mjs` 的 `/api/weibo/reposts`
- `server.mjs` 的 `/api/weibo/draw-attempts`
- `server.mjs` 的 `/api/draws`

影响：

如果服务器公网开放，攻击者即使不能从浏览器跨域成功，也可以用 curl、脚本或代理直接请求你的 API。这样可能导致：

- 消耗 3Mbps 服务器带宽。
- 占用 `MAX_ACTIVE_JOBS` 抓取任务。
- 使用服务器 Cookie 池去请求微博，增加 Cookie 失效或被风控概率。
- 写入大量开奖记录或抽奖尝试记录。

已修复：

- 新增 `API_KEY` 环境变量。
- 设置后，除 `/api/health` 外的 API 都需要 `x-api-key` 或 `Authorization: Bearer`。
- 前端设置面板可填写 API Key。

部署建议：

```ini
[Service]
Environment=API_KEY=换成openssl生成的长随机字符串
```

### S2. Cookie 明文存储在服务器本地文件

位置：

- `server.mjs`
- `output/auth/weibo-cookie.json`

影响：

接口不会返回 Cookie 明文，但如果服务器被入侵、Linux 用户权限设置过宽、或者你误把 `output/` 上传到 GitHub，Cookie 会泄露。

已修复：

- `output/auth` 目录写入时尝试设置为 `0700`。
- `weibo-cookie.json` 写入时尝试设置为 `0600`。
- `.gitignore` 已忽略 `output/` 和 `profiles/`。

仍需你部署时注意：

```bash
sudo chown -R www-data:www-data /opt/weibo-redpacket-probe/output
sudo chmod 700 /opt/weibo-redpacket-probe/output/auth
sudo chmod 600 /opt/weibo-redpacket-probe/output/auth/weibo-cookie.json
```

## 中风险

### S3. CORS 不是认证

位置：

- `server.mjs` 的 `applyCors`

说明：

CORS 只能限制“别的网站在浏览器里调用你的 API”。它不能限制 curl、服务器脚本、爬虫直接请求。所以正式部署不能只依赖 `CORS_ORIGINS`。

已缓解：

- 增加 `API_KEY`。

部署建议：

同时使用：

```ini
Environment=CORS_ORIGINS=https://你的GitHub用户名.github.io
Environment=API_KEY=长随机字符串
```

### S4. 缺少更强的边缘限流

位置：

- `server.mjs`
- `deploy/Caddyfile`

说明：

本次加了 Node 进程内的基础限流，能挡住低强度滥用。但如果有人高强度攻击，2C/2GB/3Mbps 服务器仍可能被打满。Node 内存限流也会在服务重启后清空。

建议：

- 不要开放 4173 端口到公网，只允许 Caddy 的 80/443。
- 云厂商安全组只开 22、80、443。
- 有条件的话用 Cloudflare 或服务器商的 WAF/防护。
- Caddy 前面可加 CDN，但注意不要缓存 `/api/*`。

### S5. GitHub Pages 前端不能保存秘密

位置：

- `static/config.js`
- `src/App.jsx`

说明：

GitHub Pages 上的所有前端代码、配置、图片都公开可见。不能把 Cookie、API_KEY、access_token 写进代码或 `static/config.js`。

已采用：

- `static/config.js` 只写后端 API 地址。
- API Key 在网页设置里手动输入，只存在本机 localStorage。

## 低风险 / 防御增强

### S6. 安全响应头依赖应用和反向代理

位置：

- `server.mjs`
- `deploy/Caddyfile`

已增强：

- 应用层增加 `X-Content-Type-Options`
- 应用层增加 `X-Frame-Options`
- 应用层增加 `Referrer-Policy`
- 应用层增加基础 `Permissions-Policy`

后续可选：

- 在 Caddy 增加同样的响应头。
- 如果确认没有内联样式兼容问题，再设计 CSP。

## 最终建议

你的正式部署建议使用：

```text
GitHub Pages 前端 + HTTPS API 域名 + API_KEY + Caddy 反代 + 防火墙只开 80/443/22
```

这样别人不能直接从网站拿到 Cookie；没有 API Key 的人也不能正常调用你的后端 API。真正需要重点保护的是：

- 不要泄露 `API_KEY`
- 不要上传 `output/`
- 不要上传 `profiles/`
- 不要把 Cookie 写进 GitHub
- 不要把 4173 直接开放公网

