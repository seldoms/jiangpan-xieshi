import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, migrate, MIGRATIONS_DIR } from '../src/db.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// 迁移清单从目录动态读取：每加一个迁移文件不必再手改这份测试（前两次都漏改过）
const ALL_MIGRATIONS = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

test('db: 内存库建表、迁移可重复执行、外键和唯一约束生效', () => {
  const db = createDb(':memory:');

  // 迁移已执行且可重复（openDatabase 内已跑过一次，再跑应跳过）
  const names = db.all('SELECT name FROM schema_migrations').map((r) => r.name);
  assert.deepEqual(names, ALL_MIGRATIONS);
  db.raw.pragma('foreign_keys = ON');

  const now = new Date().toISOString();
  db.run(
    'INSERT INTO users (order_code, display_name, status, created_at) VALUES (?, ?, ?, ?)',
    '测试用户a1b2', '测试用户', 'active', now,
  );
  // order_code 全局唯一
  assert.throws(() =>
    db.run(
      'INSERT INTO users (order_code, display_name, status, created_at) VALUES (?, ?, ?, ?)',
      '测试用户a1b2', '另一个用户', 'active', now,
    ),
  );

  db.run(
    "INSERT INTO batches (name, cutoff_time, status, created_at) VALUES ('b1', ?, 'open', ?)",
    now, now,
  );
  db.run(
    "INSERT INTO specs (batch_id, gender, weight_label, price_cents) VALUES (1, 'male', '4两', 8800)",
  );

  const snapshot = JSON.stringify({ prices: { 1: 8800 }, cutoff: now });
  db.run(
    `INSERT INTO orders (batch_id, seq, order_no, user_id, source, status, crab_cents, config_snapshot, idempotency_key, created_at)
     VALUES (1, 1, 'D260919-0001', 1, 'personal', 'submitted', 88000, ?, 'idem-1', ?)`,
    snapshot, now,
  );
  // UNIQUE(batch_id, seq)
  assert.throws(() =>
    db.run(
      `INSERT INTO orders (batch_id, seq, order_no, user_id, source, status, crab_cents, config_snapshot, created_at)
       VALUES (1, 1, 'D260919-0002', 1, 'personal', 'submitted', 100, '{}', ?)`,
      now,
    ),
  );
  // idempotency_key 唯一
  assert.throws(() =>
    db.run(
      `INSERT INTO orders (batch_id, seq, order_no, user_id, source, status, crab_cents, config_snapshot, idempotency_key, created_at)
       VALUES (1, 2, 'D260919-0003', 1, 'personal', 'submitted', 100, '{}', 'idem-1', ?)`,
      now,
    ),
  );

  // shipments 外键：不存在的 order_id 拒绝
  assert.throws(() =>
    db.run(
      `INSERT INTO shipments (order_id, seq, recipient, phone, address, copies, packaging, items_json, crab_cents, created_at, updated_at)
       VALUES (999, 1, '张三', '13800000000', '某地', 1, 'plain', '[]', 0, ?, ?)`,
      now, now,
    ),
  );

  // 正常插入 shipment
  db.run(
    `INSERT INTO shipments (order_id, seq, recipient, phone, address, copies, packaging, items_json, crab_cents, created_at, updated_at)
     VALUES (1, 1, '张三', '13800000000', '江苏省某市', 1, 'gift', '[{"specId":1,"qty":10}]', 88000, ?, ?)`,
    now, now,
  );
  const ship = db.get('SELECT * FROM shipments WHERE order_id = 1');
  assert.equal(ship.status, 'fishing');
  assert.equal(ship.freight_cents, null);

  db.close();
});


test('db: 旧履约数据迁移为三态，保留金额、明细和外键', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TEXT)`);
  for (const name of ['001_init.sql', '002_settings.sql', '003_group_members_editkey.sql']) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, '2026-09-19')").run(name);
  }
  db.exec(`
    INSERT INTO users (id, order_code, display_name, created_at) VALUES (1, 'migration1', '测试', '2026-09-19');
    INSERT INTO batches (id, name, cutoff_time, created_at) VALUES (1, '测试', '2026-09-19', '2026-09-19');
    INSERT INTO orders (id, batch_id, seq, order_no, user_id, source, crab_cents, config_snapshot, created_at)
      VALUES (1, 1, 1, 'D260919-0001', 1, 'personal', 10000, '{}', '2026-09-19');
  `);
  const insert = db.prepare(`INSERT INTO shipments
    (id, order_id, seq, recipient, phone, address, copies, packaging, items_json, crab_cents, status, freight_cents, created_at, updated_at)
    VALUES (?, 1, ?, '测试', '13800000000', '测试地址', 1, 'plain', '[]', 10000, ?, ?, '2026-09-19', '2026-09-19')`);
  const cases = [['fishing', null, 'fishing'], ['packed', null, 'packed'], ['delivering', null, 'packed'], ['delivering', 1800, 'shipped'], ['delivering', 0, 'shipped'], ['shipped', 1200, 'shipped']];
  cases.forEach(([status, freight], i) => insert.run(i + 1, i + 1, status, freight));
  const before = db.prepare('SELECT * FROM shipments ORDER BY id').all();
  assert.deepEqual(migrate(db), ALL_MIGRATIONS.filter((name) => name >= '004'));
  assert.deepEqual(db.prepare('SELECT * FROM shipments ORDER BY id').all(), before.map((row, i) => ({ ...row, status: cases[i][2] })));
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.throws(() => db.prepare("UPDATE shipments SET status = 'delivering' WHERE id = 1").run());
  assert.deepEqual(migrate(db), []);
});
