# 只读微博登录态接口接入说明

把本文件整份发给接收方项目（或它的 AI 助手）即可。文中 `YOUR-BACKEND` 和 `YOUR-COOKIE-READ-KEY` 由抽奖服务器运营者提供。

## 为什么有这个接口

微博 Cookie 没有 refresh token，接收方无法自行续期。抽奖服务器内部会持续保活并轮换微博登录态，因此由它统一暴露一个只读接口，接收方按需拉取当前可用的登录态，不需要自己登录微博。

## 接口

```
GET https://YOUR-BACKEND/v1/cookie/current
```

请求头二选一：

```
x-cookie-read-key: YOUR-COOKIE-READ-KEY
Authorization: Bearer YOUR-COOKIE-READ-KEY
```

不要使用 `x-api-key`：该接口与前端共享的访问密钥完全隔离，不认这个请求头。

## 响应

成功（HTTP 200，`cache-control: no-store`）：

```json
{
  "ok": true,
  "cookie": "SUB=...; SUBP=...",
  "savedAt": "2026-09-10T05:35:11.813Z",
  "lastValidAt": "2026-09-10T05:35:11.813Z",
  "quarantined": false
}
```

| 字段 | 含义 |
| --- | --- |
| `cookie` | 完整登录态字符串，可直接作为 `Cookie` 请求头发给 `weibo.com` / `m.weibo.cn` |
| `savedAt` | 服务器写入该登录态的时间（ISO 8601） |
| `lastValidAt` | 最近一次校验通过的时间 |
| `quarantined` | 为 `true` 表示服务器判定该登录态可能已失效（临时隔离期），仍会返回，但应视为不可靠 |

状态码：

| 状态码 | 含义 |
| --- | --- |
| 200 | 正常返回 |
| 401 | 密钥错误或未提供 |
| 403 | 来源不是本机回环且未使用 HTTPS，或来源未授权 |
| 404 | 接口未启用（运营者已关闭） |
| 503 | 服务器当前没有任何可用登录态 |

## 使用要求

- 不要缓存超过 5 分钟；建议轮询间隔不低于 5 分钟，或仅在自身请求遇到登录态失效时再拉取。
- 不要写入日志、监控上报或前端明文存储；该响应的价值等同于微博账号登录态。
- 只通过服务端调用，不要从浏览器或小程序前端直接请求。
- 一旦发现泄漏，立即通知运营者重新登录微博，使旧 Cookie 失效。

## 客户端示例

curl：

```bash
curl -sS -H "x-cookie-read-key: ${COOKIE_READ_KEY}" https://YOUR-BACKEND/v1/cookie/current
```

Node.js：

```js
const url = 'https://YOUR-BACKEND/v1/cookie/current';
const key = process.env.COOKIE_READ_KEY;

export async function fetchWeiboCookie() {
  const response = await fetch(url, {
    headers: { 'x-cookie-read-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 503) return null;
  if (!response.ok) throw new Error(`cookie api ${response.status}`);
  const payload = await response.json();
  return payload.cookie || null;
}
```

Python：

```python
import os, requests

def fetch_weibo_cookie():
    response = requests.get(
        "https://YOUR-BACKEND/v1/cookie/current",
        headers={"x-cookie-read-key": os.environ["COOKIE_READ_KEY"]},
        timeout=10,
    )
    if response.status_code == 503:
        return None
    response.raise_for_status()
    return response.json().get("cookie")
```

微信小程序（云函数/服务端调用，不要放在小程序端）：

```js
const response = await fetch('https://YOUR-BACKEND/v1/cookie/current', {
  headers: { 'x-cookie-read-key': process.env.COOKIE_READ_KEY },
});
const { cookie } = await response.json();
```

## 失败处理建议

- `503`：退避重试（例如 5 分钟），不要高频轮询。
- `401`：密钥可能已轮换，向运营者索取新密钥。
- `403`：确认调用方走 HTTPS，或与服务器在同一台机器上通过回环地址调用。
- `quarantined: true`：先用一次真实请求验证；失败就等下一轮拉取，不要高频重试。

## 同机调用

只有在部署时**没有**配置 `COOKIE_READ_KEY` 的情况下，同机才可以用回环地址免密钥调用：

```bash
curl -sS http://127.0.0.1:4173/v1/cookie/current
```

免密钥路径仅在请求来自本机回环、且 `Host` 也是回环地址时放行。**一旦配置了 `COOKIE_READ_KEY`（安装脚本默认会配置），无论同机还是跨机都必须携带该密钥**，跨机还必须使用 HTTPS。

## 运营者侧：启用、轮换与停用

新部署由安装脚本默认生成密钥并开启。已有部署在 `/etc/sameko-weibo-lottery.env` 中确认或追加：

```bash
ENABLE_COOKIE_READ_API=1
COOKIE_READ_KEY=<64 位十六进制字符>
```

修改后重启服务：

```bash
systemctl restart sameko-weibo-lottery
```

验证：

```bash
curl -i -H "x-cookie-read-key: ${COOKIE_READ_KEY}" https://YOUR-BACKEND/v1/cookie/current
```

轮换密钥：生成新的 64 位十六进制值替换 `COOKIE_READ_KEY` 后重启，并同步通知接收方。停用：把 `ENABLE_COOKIE_READ_API` 改为 `0` 后重启，接口按 404 处理。

## 合规提醒

该响应等同于微博登录态。开启后应把接收该登录态的服务列入隐私政策的 `dataRecipientDisclosure` 字段，只提供给确有必要的受信服务，并在服务不再需要时关闭接口或轮换密钥。
