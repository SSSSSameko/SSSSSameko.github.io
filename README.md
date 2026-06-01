# 微博转发抽奖助手

一个用于微博转发抽奖的小工具，支持抓取可见转发、筛选候选、滚动开奖和导出开奖记录图。

## 功能

- H5 Cookie 抓取可见转发列表
- 手动导入名单开奖
- 奖项名称和人数自定义
- 中奖名单滚动动画
- 开奖记录图和 CSV 导出
- 后端 Cookie 池自动校验和失效清理

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

## 部署

前端可以托管在 GitHub Pages，后端部署在自己的服务器上。公开前端通过 `static/config.js` 指向后端 API。

生产环境建议：

- 后端只监听 `127.0.0.1`，由 Caddy 或 Nginx 反向代理到 HTTPS
- `output/`、`profiles/`、`.env` 不要提交到 GitHub
- 不要把微博 Cookie、服务器密码、API Key 写进代码或 README
- `CORS_ORIGINS` 只填写自己的前端域名

## 安全说明

这个项目会处理微博 Cookie。Cookie 属于敏感登录凭据，请只在可信服务器上运行后端，并定期清理 `output/auth/weibo-cookie.json`。
