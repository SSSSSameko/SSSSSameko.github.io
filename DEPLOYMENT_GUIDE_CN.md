# 微博转发抽奖助手部署教程（小白版）

这份教程按“能直接打开网站使用”为目标写。

## 先说结论

你的服务器是 2 核 CPU / 2GB 内存 / 3Mbps 带宽，推荐方案是：

1. 前端放 GitHub Pages，也就是 `https://你的用户名.github.io/仓库名/`
2. 后端 API 放你的服务器，用 HTTPS 域名，例如 `https://api.example.com`
3. 前端通过 `static/config.js` 连接后端 API

GitHub Pages 很方便，但它只能托管静态前端，不能运行 `server.mjs` 这种 Node.js 后端。所以完整可用的网站需要“GitHub Pages + 你的服务器”一起用。

如果你想最简单先跑通，也可以用“服务器一体化方案”：前端和后端都放服务器，一个域名直接打开，例如 `https://draw.example.com`。这个更适合第一次部署测试。

## 推荐系统

小白优先选：

```text
Ubuntu 24.04 LTS Minimal
```

原因：教程多、命令好查、Node.js / Caddy / systemd 都好装。2GB 内存够用，但建议加 2GB swap。

## 你需要准备

- 一个 GitHub 账号
- 一个 GitHub 仓库，例如 `weibo-redpacket-probe`
- 一台 Linux 服务器，推荐 Ubuntu 24.04 LTS
- 一个域名或子域名，至少给后端 API 用，例如 `api.example.com`
- DNS 里把 `api.example.com` 的 A 记录指向你的服务器公网 IP

如果没有域名，GitHub Pages 页面不能稳定调用你的 HTTP 后端，因为 GitHub Pages 是 HTTPS，浏览器会拦截 HTTPS 页面访问普通 `http://服务器IP:4173`。

## 第 1 步：本地确认能跑

Windows PowerShell：

```powershell
cd C:\Users\35110\Desktop\GitHub\11z\weibo-redpacket-probe
npm install
npm run build
npm start
```

浏览器打开：

```text
http://127.0.0.1:4173/
```

健康检查：

```text
http://127.0.0.1:4173/api/health
```

能看到 `ok: true` 就说明本地前后端都正常。

## 第 2 步：推送到 GitHub

先在 GitHub 网页创建一个空仓库，比如：

```text
weibo-redpacket-probe
```

然后在本地执行：

```powershell
cd C:\Users\35110\Desktop\GitHub\11z\weibo-redpacket-probe
git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin https://github.com/你的GitHub用户名/weibo-redpacket-probe.git
git push -u origin main
```

注意：不要上传 Cookie、登录态、运行输出。项目里的 `.gitignore` 已经忽略了：

```text
node_modules/
dist/
profiles/
output/
.env
```

## 第 3 步：开启 GitHub Pages 前端

进入 GitHub 仓库页面：

```text
Settings -> Pages -> Build and deployment -> Source
```

选择：

```text
GitHub Actions
```

本项目已经有：

```text
.github/workflows/pages.yml
```

你 push 到 `main` 后，它会自动执行：

```bash
npm ci
npm run build
```

然后把 `dist/` 发布到 GitHub Pages。

前端地址通常是：

```text
https://你的GitHub用户名.github.io/weibo-redpacket-probe/
```

## 第 4 步：服务器安装基础环境

SSH 登录服务器后执行：

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y git curl ufw caddy
```

安装 Node.js 24：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

建议加 2GB swap：

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

打开防火墙端口：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

不要直接开放 4173 到公网，后面用 Caddy 转发。

## 第 5 步：部署后端到服务器

```bash
cd /opt
sudo git clone https://github.com/你的GitHub用户名/weibo-redpacket-probe.git
sudo chown -R $USER:$USER /opt/weibo-redpacket-probe
cd /opt/weibo-redpacket-probe
npm ci
npm run build
npm prune --omit=dev
mkdir -p output/draws output/auth
sudo chown -R www-data:www-data /opt/weibo-redpacket-probe/output
```

复制 systemd 服务：

```bash
sudo cp deploy/weibo-draw.service /etc/systemd/system/weibo-draw.service
```

给 GitHub Pages 配 CORS。注意这里只写“源”，不带仓库路径：

```bash
sudo systemctl edit weibo-draw
```

填入：

```ini
[Service]
Environment=CORS_ORIGINS=https://你的GitHub用户名.github.io
Environment=API_KEY=换成一串很长的随机密码
```

保存后启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now weibo-draw
sudo systemctl status weibo-draw
```

本机检查：

```bash
curl http://127.0.0.1:4173/api/health
```

## 第 6 步：用 Caddy 给后端加 HTTPS

假设你的后端域名是：

```text
api.example.com
```

编辑 Caddy：

```bash
sudo nano /etc/caddy/Caddyfile
```

写入：

```caddyfile
api.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:4173
}
```

重载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

浏览器打开：

```text
https://api.example.com/api/health
```

看到 `ok: true` 就说明后端 HTTPS 正常。

## 第 7 步：让 GitHub Pages 前端自动连接后端

打开本地文件：

```text
static/config.js
```

改成：

```js
window.WEIBO_DRAW_API_BASE = 'https://api.example.com';
```

提交并推送：

```powershell
git add static/config.js
git commit -m "Configure production API"
git push
```

等 GitHub Actions 跑完，再打开：

```text
https://你的GitHub用户名.github.io/weibo-redpacket-probe/
```

这时网站就应该能直接使用，不需要你每次手动填 API 地址。

如果服务器设置了 `API_KEY`，第一次打开网页后点右上角齿轮，在 `API Key` 输入同一串随机密码，再点“测试连接”。这个 Key 只存在你自己的浏览器里，不要写进 GitHub 仓库，也不要发给别人。

## 备用：服务器一体化方案

如果你不想先折腾 GitHub Pages，可以只用服务器：

1. DNS 把 `draw.example.com` 指向服务器 IP
2. 服务器运行 `weibo-draw` 服务
3. Caddy 配成：

```caddyfile
draw.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:4173
}
```

然后直接打开：

```text
https://draw.example.com/
```

这个方案最简单，但前端资源也走你的 3Mbps 服务器带宽。当前项目资源不大，自己用通常也没问题。

## 日常更新

前端 UI 改动：

```powershell
git add .
git commit -m "Update UI"
git push
```

GitHub Actions 会自动更新 GitHub Pages。

后端代码改动后，在服务器执行：

```bash
cd /opt/weibo-redpacket-probe
git pull
npm ci
npm prune --omit=dev
sudo systemctl restart weibo-draw
```

如果服务器一体化部署，并且前端也在服务器上跑：

```bash
npm run build
sudo systemctl restart weibo-draw
```

## 常见问题

### GitHub Pages 页面能打开，但载入候选失败

检查：

```text
https://api.example.com/api/health
```

再检查 systemd 里有没有配置：

```text
CORS_ORIGINS=https://你的GitHub用户名.github.io
```

如果你配置了 `API_KEY`，还要检查网页右上角设置里是否填了正确的 API Key。

### 页面提示 API 连接失败

GitHub Pages 不能访问普通 HTTP API。后端必须是：

```text
https://api.example.com
```

不能是：

```text
http://服务器IP:4173
```

如果返回 `API Key 不正确或未提供`，说明后端已经开启保护，需要在网页设置里填 API Key。

### 怎么生成 API_KEY

服务器上执行：

```bash
openssl rand -hex 32
```

复制输出结果，填到 systemd override：

```ini
[Service]
Environment=API_KEY=这里粘贴openssl生成的字符串
```

然后重启：

```bash
sudo systemctl daemon-reload
sudo systemctl restart weibo-draw
```

### 502 Bad Gateway

服务器执行：

```bash
sudo systemctl status weibo-draw
sudo journalctl -u weibo-draw -n 100 --no-pager
```

### 候选抓不到

通常是微博 Cookie 失效、微博接口限制、或该微博转发不可见。可以先用“手动导入”模式测试抽奖流程是否正常。

### GitHub Pages 图片或样式丢失

本项目已经改成兼容 `用户名.github.io/仓库名/` 子路径的构建方式。如果你部署的是旧代码，先更新后重新 push。

## 选型建议

小白最稳路线：

```text
先用服务器一体化跑通 -> 再切 GitHub Pages + API 服务器
```

长期最推荐：

```text
GitHub Pages 放前端，服务器只跑 API
```

这样最省服务器带宽，也最适合你的 2C / 2GB / 3Mbps 配置。
