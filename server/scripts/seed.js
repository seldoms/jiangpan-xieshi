import { loadConfig, TIMEZONE } from '../src/config.js';
import { createDb } from '../src/db.js';
import { BOX_CAPACITY } from '../src/money.js';

const config = loadConfig();
const db = createDb(config.databasePath);
const now = new Date().toISOString();

// 当日 17:00 Asia/Shanghai 的 UTC 表示
const shDate = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
const cutoffUtc = new Date(`${shDate}T17:00:00+08:00`).toISOString();

const seed = db.tx(() => {
  db.run(
    'INSERT OR IGNORE INTO admin_users (id, name, token, role, created_at) VALUES (1, ?, ?, ?, ?)',
    'admin', config.adminToken, 'admin', now,
  );

  db.run(
    'INSERT OR IGNORE INTO batches (id, name, cutoff_time, status, created_at) VALUES (1, ?, ?, ?, ?)',
    `dev-batch-${shDate}`, cutoffUtc, 'open', now,
  );

  // 测试规格：公4两 / 公3.5两 / 母3.5两 / 母3两（测试价，单位：分/只）
  const specs = [
    [1, 'male', '4两', 8800, 1],
    [2, 'male', '3.5两', 6800, 2],
    [3, 'female', '3.5两', 9800, 3],
    [4, 'female', '3两', 7800, 4],
  ];
  for (const [id, gender, label, price, sort] of specs) {
    db.run(
      'INSERT OR IGNORE INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (?, 1, ?, ?, ?, 1, ?)',
      id, gender, label, price, sort,
    );
  }

  db.run(
    'INSERT OR IGNORE INTO package_templates (id, name, packaging, active, created_at) VALUES (1, ?, ?, 1, ?)',
    '5公5母混合礼盒', 'gift', now,
  );
  db.run(
    'INSERT OR IGNORE INTO package_templates (id, name, packaging, active, created_at) VALUES (2, ?, ?, 1, ?)',
    '全母礼盒', 'gift', now,
  );

  const templateItems = [
    // 模板1：5公5母 = 公4两×2 + 公3.5两×3 + 母3.5两×3 + 母3两×2 = 10
    [1, 1, 1, 2],
    [2, 1, 2, 3],
    [3, 1, 3, 3],
    [4, 1, 4, 2],
    // 模板2：全母 = 母3.5两×5 + 母3两×5 = 10
    [5, 2, 3, 5],
    [6, 2, 4, 5],
  ];
  for (const [id, templateId, specId, qty] of templateItems) {
    db.run(
      'INSERT OR IGNORE INTO package_template_items (id, template_id, spec_id, quantity) VALUES (?, ?, ?, ?)',
      id, templateId, specId, qty,
    );
  }

  // 校验：同一模板的 items 数量合计必须为 10
  for (const t of db.all('SELECT id, name FROM package_templates')) {
    const { total } = db.get(
      'SELECT COALESCE(SUM(quantity), 0) AS total FROM package_template_items WHERE template_id = ?',
      t.id,
    );
    if (total !== BOX_CAPACITY) {
      throw new Error(`package template "${t.name}" items sum to ${total}, must be ${BOX_CAPACITY}`);
    }
  }

  db.run(
    "INSERT OR IGNORE INTO users (id, order_code, display_name, status, created_at) VALUES (1, ?, ?, 'active', ?)",
    '测试用户a1b2', '测试用户', now,
  );
});

seed();

const seedSettings = db.tx(() => {
  db.run(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
    'packaging.plain', '0',
  );
  db.run(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
    'packaging.gift', '1000',
  );
});

seedSettings();

console.log('seed ok:', {
  admins: db.get('SELECT COUNT(*) AS c FROM admin_users').c,
  batches: db.get('SELECT COUNT(*) AS c FROM batches').c,
  specs: db.get('SELECT COUNT(*) AS c FROM specs').c,
  templates: db.get('SELECT COUNT(*) AS c FROM package_templates').c,
  users: db.get('SELECT COUNT(*) AS c FROM users').c,
});
console.log('settings seed ok:', db.all('SELECT key, value FROM settings ORDER BY key'));
db.close();
