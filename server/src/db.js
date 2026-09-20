import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SERVER_ROOT } from './config.js';

export const MIGRATIONS_DIR = path.join(SERVER_ROOT, 'migrations');

/**
 * 执行未跑过的迁移（按文件名排序），已执行的跳过，可重复调用。
 */
export function migrate(db, migrationsDir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  )`);

  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name),
  );
  const insert = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  );

  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      insert.run(file, new Date().toISOString());
    })();
    ran.push(file);
  }
  return ran;
}

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * 查询助手：SQL 统一收敛在本层和后续的 repository 层，
 * 路由/服务层不得散落手写 prepare。
 */
export function createDb(dbPath) {
  const db = openDatabase(dbPath);
  return {
    raw: db,
    all: (sql, ...params) => db.prepare(sql).all(...params),
    get: (sql, ...params) => db.prepare(sql).get(...params),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    tx: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}
