#!/usr/bin/env bash
# SQLite 每日备份（带完整性校验）
# 安装：crontab -e 加一行
#   17 4 * * * /opt/crabshop/deploy/backup.sh >> /var/log/crabshop-backup.log 2>&1
#
# 2026-09-20 加固（原版备份后不校验，等于"备份了但不知道能不能用"）：
#   · 备份后立刻 integrity_check + 表数校验
#   · 校验不通过 → 保留现场文件、不轮换旧备份、非零退出（cron 会记进日志）
#   · 只有校验通过才删旧备份，避免"留下坏的、删掉好的"
#   · 备份文件属主对齐 crabshop（与数据目录一致）
#
# ⚠️ 必须用 sqlite3 的 .backup，不要用 cp：
#   本库是 WAL 模式，app.db-wal 里可能有几 MB 未合并的改动，
#   直接 cp app.db 会丢掉这部分数据（实测遇到过 wal 2.8MB 的情况）。
set -euo pipefail

DB=/opt/crabshop/data/app.db
DIR=/opt/crabshop/backups
KEEP=14
MIN_TABLES=10          # 当前 15 张表；低于这个数说明备份明显不完整

mkdir -p "$DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/app-$TS.db"

# ── 1) 备份（.backup 会自动带上 WAL 内容）──
sqlite3 "$DB" ".backup '$OUT'"

# ── 2) 校验：完整性 ──
if ! sqlite3 "$OUT" "PRAGMA integrity_check;" | grep -q '^ok$'; then
  echo "$(date -Is) BACKUP FAILED: integrity_check 未通过，文件保留待查：$OUT" >&2
  exit 1
fi

# ── 3) 校验：表数（防止"备份了个空壳"）──
TABLES=$(sqlite3 "$OUT" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';")
if [ "$TABLES" -lt "$MIN_TABLES" ]; then
  echo "$(date -Is) BACKUP FAILED: 表数异常 ($TABLES < $MIN_TABLES)，文件保留待查：$OUT" >&2
  exit 1
fi

# ── 4) 校验：关键表能查（防止页面级损坏）──
if ! sqlite3 "$OUT" "SELECT COUNT(*) FROM specs; SELECT COUNT(*) FROM admin_users;" >/dev/null 2>&1; then
  echo "$(date -Is) BACKUP FAILED: 关键表不可查，文件保留待查：$OUT" >&2
  exit 1
fi

# ── 5) 校验通过，才轮换旧备份 ──
ls -1t "$DIR"/app-*.db | tail -n +$((KEEP + 1)) | xargs -r rm -f

# ── 6) 属主对齐（服务以 crabshop 身份跑）──
chown crabshop:crabshop "$OUT" 2>/dev/null || true

SIZE=$(du -h "$OUT" | cut -f1)
echo "$(date -Is) backup ok: app-$TS.db (tables=$TABLES, size=$SIZE, verified)"
