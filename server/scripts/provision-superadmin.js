import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { normalizeOrderCode, validateOrderCode } from '../src/orderCode.js';

// 显式运行才初始化，不跟随 seed 或服务启动自动创建固定超级管理员。
export function provisionSuperadmin(db, rawCode) {
  const code = normalizeOrderCode(rawCode);
  const formatError = validateOrderCode(code);
  if (formatError) throw new Error(formatError);
  return db.tx(() => {
    if (db.get('SELECT id FROM users WHERE order_code = ?', code)) {
      throw new Error('下单码已属于普通用户，拒绝覆盖或提升权限');
    }
    const existing = db.get('SELECT * FROM admin_users WHERE token = ? COLLATE NOCASE OR name = ? COLLATE NOCASE', code, code);
    if (existing) {
      if (existing.token !== code || existing.name !== code || existing.role !== 'superadmin') {
        throw new Error('管理员名称或下单码已存在且角色不一致，拒绝覆盖');
      }
      return { id: existing.id, role: existing.role, created: false };
    }
    const result = db.run(
      "INSERT INTO admin_users (name, token, role, created_at) VALUES (?, ?, 'superadmin', ?)",
      code, code, new Date().toISOString(),
    );
    return { id: Number(result.lastInsertRowid), role: 'superadmin', created: true };
  })();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let db;
  try {
    if (process.argv.length !== 3) throw new Error('用法：npm run provision:superadmin -- <下单码>');
    const config = loadConfig();
    db = createDb(config.databasePath);
    const result = provisionSuperadmin(db, process.argv[2]);
    console.log(result.created ? '超级管理员已创建' : '超级管理员已存在，未修改', { id: result.id, role: result.role });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
