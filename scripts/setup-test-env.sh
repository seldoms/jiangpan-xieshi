#!/usr/bin/env bash
# 搭建「测试环境」—— 正式上线后测试不再碰生产数据
#
#   cd /opt/crabshop/repo && bash scripts/setup-test-env.sh
#
# 产出：
#   测试库    /opt/crabshop/data/app-test.db      （结构与生产库完全一致，靠同一套迁移）
#   测试后端  systemd crabshop-test.service       → 127.0.0.1:7650
#   测试前端  nginx 站点 crabshop-test            → http://<ip>:7651（复用生产 dist，/api 反代到 7650）
#
# 与生产的关系：
#   · 跑同一份代码（/opt/crabshop/server），只是 DATABASE_PATH 不同 → 测的就是线上那套逻辑
#   · 生产数据零风险：测试实例只读写 app-test.db
#   · 前端复用同一份 dist，界面与线上一致
#
# 幂等：可重复执行（已存在的库/服务/站点只更新，不重复创建）
set -euo pipefail

REPO=/opt/crabshop/repo
RUN=/opt/crabshop/server
DATA=/opt/crabshop/data
DIST=/opt/crabshop/dist
TEST_DB="$DATA/app-test.db"
PROD_DB="$DATA/app.db"
BE_PORT=7650
WEB_PORT=7651
NODE=/usr/bin/node

if [ "$(id -u)" != "0" ]; then echo "需要 root（要写 systemd 与 nginx 配置）" >&2; exit 1; fi

echo "═══ 1/5 测试库 ═══"
cd "$RUN"
DATABASE_PATH="$TEST_DB" $NODE src/migrate.js

echo
echo "═══ 2/5 从生产库灌「基础配置」（只拷配置表，不拷业务数据）═══"
# 保留表：批次 / 规格 / 套餐及其明细 / 设置 / 管理员 / 审计基线
for t in batches specs package_templates package_template_items settings admin_users; do
  n=$(sqlite3 "$TEST_DB" "SELECT COUNT(*) FROM $t;")
  sqlite3 "$PROD_DB" ".dump $t" | grep '^INSERT' | sqlite3 "$TEST_DB" 2>/dev/null || true
  m=$(sqlite3 "$TEST_DB" "SELECT COUNT(*) FROM $t;")
  printf '  %-22s 测试库 %s → %s 行\n' "$t" "$n" "$m"
done

echo
echo "═══ 3/5 测试后端服务 ═══"
# 测试实例需要独立的环境文件：
#   · ADMIN_TOKEN 从生产 .env 原样搬过来（值不落屏，只在两个 600 权限文件间传递）
#   · SESSION_COOKIE_SECURE 必须显式 false —— 测试实例走 http，带 Secure 的 cookie
#     会被浏览器直接丢弃，表现为「所有人都登不上」，这是踩过的坑
ENV_PROD=/opt/crabshop/server/.env
ENV_TEST=/opt/crabshop/server/.env.test
if [ -f "$ENV_PROD" ]; then
  grep '^ADMIN_TOKEN=' "$ENV_PROD" > "$ENV_TEST" || true
fi
echo 'SESSION_COOKIE_SECURE=false' >> "$ENV_TEST"
chown crabshop:crabshop "$ENV_TEST"
chmod 600 "$ENV_TEST"
echo "  .env.test 已生成：$(sed 's/=.*/=<已隐藏>/' "$ENV_TEST" | tr '\n' ' ')"

cat > /etc/systemd/system/crabshop-test.service <<EOF
[Unit]
Description=Crabshop TEST API (port $BE_PORT, db app-test.db)
After=network.target

[Service]
Type=simple
User=crabshop
WorkingDirectory=$RUN
Environment=NODE_ENV=production
Environment=PORT=$BE_PORT
Environment=DATABASE_PATH=$TEST_DB
EnvironmentFile=$ENV_TEST
ExecStart=$NODE src/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
chown -R crabshop:crabshop "$DATA"
systemctl daemon-reload
systemctl enable --now crabshop-test.service >/dev/null 2>&1 || true
systemctl restart crabshop-test.service

echo
echo "═══ 4/5 测试前端站点（nginx $WEB_PORT → 前端 dist + /api 反代到 $BE_PORT）═══"
cat > /etc/nginx/sites-available/crabshop-test <<EOF
# 测试环境入口：复用生产 dist，接口打到测试后端（独立测试库）
server {
    listen $WEB_PORT;
    server_name _;
    root $DIST;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:$BE_PORT/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
ln -sf /etc/nginx/sites-available/crabshop-test /etc/nginx/sites-enabled/crabshop-test
nginx -t && systemctl reload nginx

echo
echo "═══ 5/5 验证 ═══"
sleep 2
echo "  测试后端 systemd : $(systemctl is-active crabshop-test.service) / $(systemctl is-enabled crabshop-test.service)"
echo "  测试后端健康     : $(curl -s "127.0.0.1:$BE_PORT/api/v1/health" || echo '无响应')"
echo "  测试前端页面     : HTTP $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/")"
echo "  前端反代是否通   : HTTP $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/api/v1/health")"
echo
echo "  结构差异核对（空输出 = 测试库与生产库完全一致）："
diff <(sqlite3 "$PROD_DB" ".schema" | sort) <(sqlite3 "$TEST_DB" ".schema" | sort) && echo "  ✓ 无差异"
echo
echo "完成。测试入口： http://<本机IP>:$WEB_PORT/   （生产：7648，两者互不影响）"
