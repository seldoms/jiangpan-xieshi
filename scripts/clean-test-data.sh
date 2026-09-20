#!/usr/bin/env bash
# 清理全部测试业务数据（订单 / 团购 / 用户 / 会话 / 草稿）
#
# 用途：测试结束、演示之前，一句话把测试痕迹清干净。
#   用法： cd /opt/crabshop/repo && bash scripts/clean-test-data.sh
#          （换库： DATABASE_PATH=/别的/app.db bash scripts/clean-test-data.sh）
#
# 保留：batches（批次）/ specs（规格）/ package_templates（套餐）/ settings（配置）
#       / admin_users（管理员，含 YOUR_ADMIN_CODE）/ audit_logs（审计，合规资产）/ schema_migrations
# 备份：执行前自动 .backup 到 /opt/crabshop/backups/pre-cleanup-<时间戳>.db（可回滚）
#
# ⚠️ 两件事要知道：
#   1) 这是物理删除（不是软删），删完不可从库里恢复 —— 只能从上面那份备份捞。
#   2) 删完 order_no 的序号会从 0001 重新开始（下一个订单又是 D<日期>-0001）。
set -euo pipefail

DB="${DATABASE_PATH:-/opt/crabshop/data/app.db}"
BAK_DIR="${BACKUP_DIR:-/opt/crabshop/backups}"
TS="$(date +%Y%m%d-%H%M%S)"
BAK="$BAK_DIR/pre-cleanup-$TS.db"

if [ ! -f "$DB" ]; then
  echo "找不到数据库：$DB" >&2
  exit 1
fi

mkdir -p "$BAK_DIR"
echo "→ 备份：$BAK"
sqlite3 "$DB" ".backup '$BAK'"

echo "→ 清理业务数据…"
# 按依赖顺序删（外键未强制，但保持顺序以防将来开启）
sqlite3 "$DB" "
BEGIN;
DELETE FROM shipments;
DELETE FROM orders;
DELETE FROM group_members;
DELETE FROM groups;
DELETE FROM cart_drafts;
DELETE FROM user_sessions;
DELETE FROM users;
COMMIT;"

# 服务以 crabshop 身份运行，属主必须还原
if id crabshop >/dev/null 2>&1; then
  chown -R crabshop:crabshop "$(dirname "$DB")" 2>/dev/null || true
fi

echo
echo "→ 清理后："
sqlite3 -header -column "$DB" "
SELECT 'users' AS 表, COUNT(*) AS 行数 FROM users
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'shipments', COUNT(*) FROM shipments
UNION ALL SELECT 'groups', COUNT(*) FROM groups
UNION ALL SELECT 'group_members', COUNT(*) FROM group_members
UNION ALL SELECT 'cart_drafts', COUNT(*) FROM cart_drafts
UNION ALL SELECT 'user_sessions', COUNT(*) FROM user_sessions;"

echo
echo "→ 保留（应原样）："
sqlite3 -header -column "$DB" "
SELECT 'admin_users' AS 表, COUNT(*) AS 行数 FROM admin_users
UNION ALL SELECT 'batches', COUNT(*) FROM batches
UNION ALL SELECT 'specs', COUNT(*) FROM specs
UNION ALL SELECT 'package_templates', COUNT(*) FROM package_templates
UNION ALL SELECT 'settings', COUNT(*) FROM settings
UNION ALL SELECT 'audit_logs', COUNT(*) FROM audit_logs;"

echo
echo "→ 服务健康：$(curl -s 127.0.0.1:7649/api/v1/health || echo '（接口没响应，检查服务）')"
echo "完成。备份在 $BAK"
