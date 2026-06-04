# 微博转发抽奖助手

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
- `PLAYWRIGHT_BROWSERS_PATH=/opt/sameko-weibo-lottery/ms-playwright`
- `MAX_DRAW_SAVE_BODY_BYTES=2097152`

运行数据保存在 `output/`，浏览器登录资料保存在 `output/auth/weibo-login-profile/`。这些目录不提交到 Git。

## 后台管理

后端部署完成后访问：

```text
https://你的后端地址/admin
```

使用 `ADMIN_KEY` 登录。后台可以查看开奖记录、中奖明细、最近开奖动作、抓取队列和 Cookie 池状态。
