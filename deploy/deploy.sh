#!/usr/bin/env bash
# 从本地 Mac 一键部署到 Ubuntu。用法：
#   DEPLOY_HOST=1.2.3.4 DEPLOY_USER=ubuntu bash deploy/deploy.sh
# 前置：本机已 npm run build；远端已按 deploy/README.md 完成首次装机。
set -euo pipefail

HOST="${DEPLOY_HOST:?请设置 DEPLOY_HOST}"
USER="${DEPLOY_USER:-ubuntu}"
PORT="${DEPLOY_PORT:-22}"
REMOTE=/opt/crabshop

echo "==> 构建前端"
npm run build

echo "==> 同步代码到 $USER@$HOST:$REMOTE"
rsync -az --delete -e "ssh -p $PORT" \
  --exclude node_modules --exclude data --exclude .env \
  server/ "$USER@$HOST:$REMOTE/server/"
rsync -az --delete -e "ssh -p $PORT" \
  dist/ "$USER@$HOST:$REMOTE/dist/"

echo "==> 远端安装依赖、跑迁移、重启服务"
ssh -p "$PORT" "$USER@$HOST" bash -s <<'EOF'
set -euo pipefail
cd /opt/crabshop/server
npm install --omit=dev
npm run migrate
sudo systemctl restart crabshop
sleep 2
curl -fsS http://127.0.0.1:7649/api/v1/health
EOF

echo "==> 完成"
