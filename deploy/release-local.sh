#!/usr/bin/env bash
# 在服务器上从仓库发布到运行目录。用法：cd /opt/crabshop/repo && bash deploy/release-local.sh
# 流程：构建前端 → 同步 server/ 和 dist/ 到运行目录 → 装依赖 → 迁移 → 重启 → 健康检查。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> 构建前端"
cd "$REPO"
npm run build

echo "==> 同步到运行目录"
rsync -a --delete --exclude node_modules --exclude data --exclude '.env*' \
  "$REPO/server/" /opt/crabshop/server/
rsync -a --delete "$REPO/dist/" /opt/crabshop/dist/

echo "==> 安装依赖、迁移、重启"
cd /opt/crabshop/server
npm install --omit=dev
DATABASE_PATH=/opt/crabshop/data/app.db /usr/bin/node src/migrate.js
chown -R crabshop:crabshop /opt/crabshop/server /opt/crabshop/dist /opt/crabshop/data
systemctl restart crabshop
sleep 2
curl -fsS http://127.0.0.1:7649/api/v1/health
echo
echo "==> 发布完成"
