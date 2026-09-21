# VPS + 域名：Ubuntu 自托管部署

参考拓扑：nginx `7648` 托管前端并反代 `/api` 到 Fastify `127.0.0.1:7649`，systemd 管理服务，SQLite 数据与代码分开存放。端口、目录和域名可按环境调整。

## 部署前准备

- 一台可通过 SSH 管理的 Linux VPS；本文以 Ubuntu 为例，前后端与 SQLite 共用这台机器。
- 一个自己管理的域名或子域名，例如 `shop.example.com`。将 DNS 的 A 记录指向 VPS 公网 IPv4；只有配置好 IPv6 时才添加 AAAA 记录。
- 公网 HTTPS 入口：在同一台 VPS 上配置证书和自动续期，对外提供 `443`；签发证书或 HTTP 跳转需要时开放 `80`。
- 持久化磁盘与异机备份位置。SQLite 无需独立数据库服务器，仍须定时备份并验证恢复。

本文的 nginx `7648` 是应用入口，HTTPS 反向代理转发到它，后端只监听 `127.0.0.1:7649`。公网安全组/防火墙仅开放必要的 SSH 与 Web 端口，不直接开放 `7648/7649`。HTTPS 代理须保留原始 Host；手机访问店铺与生成分享海报都使用正式域名。

## 首次准备

安装 Node.js 22 LTS（至少 22.12）、npm、nginx、sqlite3、rsync。安装依赖、运行测试和启动后端应使用相同 Node 版本。

```bash
sudo useradd -r -m -d /opt/crabshop crabshop
sudo mkdir -p /opt/crabshop/{repo,server,dist,data,backups,deploy}
sudo git clone https://github.com/seldoms/jiangpan-xieshi.git /opt/crabshop/repo
cd /opt/crabshop/repo
npm ci
npm --prefix server ci
npm run build
npm --prefix server test
```

通过受保护的编辑器创建 `/opt/crabshop/server/.env`，权限设为 `600`、所有者设为 `crabshop`。填入以下配置，并将令牌替换为自己的强随机值：

```dotenv
ADMIN_TOKEN=REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_16_CHARACTERS
HOST=127.0.0.1
SESSION_COOKIE_SECURE=true
```

`SESSION_COOKIE_SECURE=true` 需要用户通过 HTTPS 访问。应用不自动加载 `.env`；生产由 systemd 的 `EnvironmentFile` 注入，本地运行请使用 shell 环境变量。

```bash
sudo cp deploy/crabshop.service /etc/systemd/system/crabshop.service
sudo cp deploy/nginx.conf /etc/nginx/sites-available/crabshop
sudo ln -sf /etc/nginx/sites-available/crabshop /etc/nginx/sites-enabled/crabshop
sudo systemctl daemon-reload
sudo systemctl enable crabshop
sudo nginx -t
sudo systemctl reload nginx
```

为自己的域名配置 HTTPS 入口，并将请求反代到 nginx `7648`。不要把后端端口直接开放到公网。

## 发布与初始化

`release-local.sh` 使用 `/usr/bin/node`，发布前确认该路径是上面安装的 Node 22，并保证 `npm` 使用同一 Node。脚本会同步代码、安装运行依赖、执行迁移、重启并检查健康。

```bash
cd /opt/crabshop/repo
sudo bash deploy/release-local.sh
```

新库需要显式创建自己的超级管理员，然后在后台设置商品、价格和批次。生产不要运行本地演示 `seed`。

```bash
cd /opt/crabshop/server
sudo -u crabshop env DATABASE_PATH=/opt/crabshop/data/app.db \
  /usr/bin/node scripts/provision-superadmin.js 你自己设置的下单码
```

入口健康检查：`http://127.0.0.1:7648/api/v1/health`，正常返回 `{"ok":true}`。

## 日常更新与备份

1. 在待发布提交上构建和测试，确认没有夹带其他未完成改动。
2. 发布前备份数据库与上一版运行代码；`deploy/backup.sh` 提供 SQLite 在线备份示例。
3. 运行发布脚本，确认服务状态、健康检查与关键业务页面。
4. 定期执行 `deploy/restore-drill.sh`，将备份另存到其他机器或对象存储，并为服务存活、磁盘余量与备份失败配置监控。同机备份不能抵御 VPS 磁盘丢失。

迁移只增不改。回滚代码前先确认旧代码与新库兼容；数据库恢复会覆盖业务状态，必须单独核对与授权。

更多约定见 [维护说明](../docs/maintenance.md)。
