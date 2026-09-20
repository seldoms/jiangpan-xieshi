#!/usr/bin/env bash
# 备份恢复演练（隔离式）：不停服、不碰生产库，验证「备份真能起、数据真在」。
#
# 做法：把最新备份复制到临时目录 → 完整性检查 → 用临时端口起一个后端实例读真实业务接口。
# 全程不写 /opt/crabshop/data/app.db，因此随时可跑（建议每季度一次）。
#
# 用法：cd /opt/crabshop/repo && bash deploy/restore-drill.sh
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/crabshop/backups}"
DRILL_DIR="${DRILL_DIR:-/tmp/crabshop-drill}"
DRILL_PORT="${DRILL_PORT:-7650}"
SERVER_DIR="${SERVER_DIR:-/opt/crabshop/server}"

echo "==> 取最新备份"
newest="$(ls -1t "$BACKUP_DIR"/app-*.db 2>/dev/null | head -1 || true)"
if [ -z "$newest" ]; then
  echo "❌ 没有找到任何备份（$BACKUP_DIR/app-*.db），先确认 17 4 * * * 的备份 cron 是否在跑"
  exit 1
fi
echo "    $newest（$(du -h "$newest" | cut -f1)）"

rm -rf "$DRILL_DIR"
mkdir -p "$DRILL_DIR"
cp "$newest" "$DRILL_DIR/app.db"

echo "==> 完整性检查（PRAGMA integrity_check）"
integrity="$(sqlite3 "$DRILL_DIR/app.db" 'PRAGMA integrity_check;')"
if [ "$integrity" != "ok" ]; then
  echo "❌ 备份文件损坏：$integrity"
  exit 1
fi
echo "    ok"

echo "==> 关键表行数"
sqlite3 -header "$DRILL_DIR/app.db" "
  SELECT 'orders' AS 表, COUNT(*) AS 行数 FROM orders
  UNION ALL SELECT 'shipments', COUNT(*) FROM shipments
  UNION ALL SELECT 'users', COUNT(*) FROM users
  UNION ALL SELECT 'groups', COUNT(*) FROM groups
  UNION ALL SELECT 'specs', COUNT(*) FROM specs
  UNION ALL SELECT 'batches', COUNT(*) FROM batches;"

echo "==> 用临时端口 $DRILL_PORT 起实例（生产服务不受影响）"
cd "$SERVER_DIR"
NODE_ENV=production \
ADMIN_TOKEN=restore-drill-temporary-token \
DATABASE_PATH="$DRILL_DIR/app.db" \
PORT="$DRILL_PORT" HOST=127.0.0.1 \
PATH=/usr/bin:/bin nohup node src/index.js > "$DRILL_DIR/server.log" 2>&1 &
drill_pid=$!
cleanup() { kill "$drill_pid" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 20); do
  sleep 0.5
  if curl -fsS --max-time 2 "http://127.0.0.1:$DRILL_PORT/api/v1/health" >/dev/null 2>&1; then break; fi
done

health="$(curl -fsS --max-time 3 "http://127.0.0.1:$DRILL_PORT/api/v1/health" || true)"
if [ -z "$health" ]; then
  echo "❌ 备份库起不来，日志尾部："
  tail -20 "$DRILL_DIR/server.log"
  exit 1
fi
echo "    /health → $health"

echo "==> 读一次真实业务接口（确认数据可读，不只是能启动）"
curl -fsS --max-time 5 "http://127.0.0.1:$DRILL_PORT/api/v1/config/current" \
  | head -c 200
echo
echo "==> 演练通过：备份可恢复、服务可起、数据可读（生产库未被改动）"
echo "    真实恢复流程仍是：systemctl stop crabshop → 替换 data/app.db → chown crabshop:crabshop → systemctl start crabshop"
