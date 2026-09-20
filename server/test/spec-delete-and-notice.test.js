import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { isSpecOrderable, MALE_ORDERABLE_FROM } from '../src/repositories/configRepo.js';

// 本文件独占：spec-delete-and-notice.test.js
// 覆盖：① 删除规格接口（成功 / 被引用 409 / 不存在 404 / 鉴权）
//       ② 公告 Notice 读（公开）写（管理员）与三种生效状态
//       ③ config/current 的 specs[].orderable（公蟹 2026-10-01 前不可下单）

const ADMIN_HEADERS = { authorization: 'Bearer dev-admin-token' };

async function makeApp(t) {
  const db = createDb(':memory:');
  const app = await buildApp({ db, env: {} });
  t.after(async () => { await app.close(); db.close(); });
  return { app, db };
}

function insertSpec(db, {
  batchId = null, gender = 'male', weightLabel = '4两', priceCents = 8800, active = 1, sort = 0,
} = {}) {
  return Number(db.run(
    'INSERT INTO specs (batch_id, gender, weight_label, price_cents, active, sort) VALUES (?, ?, ?, ?, ?, ?)',
    batchId, gender, weightLabel, priceCents, active, sort,
  ).lastInsertRowid);
}

function insertBatch(db, { name = '公告测试批次', cutoffTime = new Date(Date.now() + 3600_000).toISOString() } = {}) {
  return Number(db.run(
    "INSERT INTO batches (name, cutoff_time, status, created_at) VALUES (?, ?, 'open', ?)",
    name, cutoffTime, new Date().toISOString(),
  ).lastInsertRowid);
}

/** 套餐模板引用：package_template_items.spec_id 外键指向 specs.id。 */
function insertTemplateWithSpec(db, specId, { name = '5公5母引规格', packaging = 'gift' } = {}) {
  const templateId = Number(db.run(
    'INSERT INTO package_templates (name, packaging, active, created_at) VALUES (?, ?, 1, ?)',
    name, packaging, new Date().toISOString(),
  ).lastInsertRowid);
  db.run('INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (?, ?, 5)', templateId, specId);
  return templateId;
}

/** 团购成员引用：group_members.spec_id 外键指向 specs.id。 */
function insertGroupMemberWithSpec(db, specId, { quantity = 5 } = {}) {
  const now = new Date().toISOString();
  const userId = Number(db.run(
    "INSERT INTO users (order_code, display_name, status, created_at) VALUES ('删除规格测试团长', '团长', 'active', ?)",
    now,
  ).lastInsertRowid);
  const batchId = insertBatch(db, { name: '团购批次' });
  const groupId = Number(db.run(
    "INSERT INTO groups (batch_id, leader_user_id, token, title, status, created_at) VALUES (?, ?, 'spec-del-token', '测试团', 'open', ?)",
    batchId, userId, now,
  ).lastInsertRowid);
  db.run(
    'INSERT INTO group_members (group_id, name, spec_id, spec_snapshot, quantity, submitted_order, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    groupId, '成员甲', specId, JSON.stringify({ specId, label: '4两', gender: 'male' }), quantity, now,
  );
  return groupId;
}

// ---------------------------------------------------------------- ① 删除规格

test('删除规格：无引用时物理删除 + 写审计（spec.delete）', async (t) => {
  const { app, db } = await makeApp(t);
  const specId = insertSpec(db, { weightLabel: '4.5两', priceCents: 9800, sort: 2 });

  const res = await app.inject({
    method: 'DELETE', url: `/api/v1/admin/specs/${specId}`, headers: ADMIN_HEADERS,
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().deleted, true);
  assert.equal(res.json().spec.id, specId);

  // 真的从库里删掉了
  assert.equal(db.get('SELECT id FROM specs WHERE id = ?', specId), undefined);
  const list = await app.inject({ method: 'GET', url: '/api/v1/admin/specs', headers: ADMIN_HEADERS });
  assert.equal(list.json().specs.length, 0);

  // 审计留痕
  const audit = db.get("SELECT * FROM audit_logs WHERE action = 'spec.delete' AND entity = 'spec' AND entity_id = ?", specId);
  assert.ok(audit, '应有 spec.delete 审计记录');
  assert.equal(audit.actor_type, 'admin');
  assert.equal(JSON.parse(audit.detail).weightLabel, '4.5两');
  assert.equal(JSON.parse(audit.detail).priceCents, 9800);
});

test('删除规格：被套餐模板引用时 409 SPEC_IN_USE，且不删除', async (t) => {
  const { app, db } = await makeApp(t);
  const specId = insertSpec(db);
  insertTemplateWithSpec(db, specId);

  const res = await app.inject({
    method: 'DELETE', url: `/api/v1/admin/specs/${specId}`, headers: ADMIN_HEADERS,
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error.code, 'SPEC_IN_USE');
  assert.match(res.json().error.message, /已被 1 个套餐\/团购引用/);
  assert.ok(db.get('SELECT id FROM specs WHERE id = ?', specId), '规格应仍存在');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'spec.delete'").n, 0);
});

test('删除规格：被团购成员引用时 409 SPEC_IN_USE，且不删除', async (t) => {
  const { app, db } = await makeApp(t);
  const specId = insertSpec(db);
  insertGroupMemberWithSpec(db, specId);

  const res = await app.inject({
    method: 'DELETE', url: `/api/v1/admin/specs/${specId}`, headers: ADMIN_HEADERS,
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error.code, 'SPEC_IN_USE');
  assert.match(res.json().error.message, /已被 1 个套餐\/团购引用/);
  assert.ok(db.get('SELECT id FROM specs WHERE id = ?', specId));
});

test('删除规格：两类引用都有时，计数为引用总数', async (t) => {
  const { app, db } = await makeApp(t);
  const specId = insertSpec(db);
  insertTemplateWithSpec(db, specId, { name: '模板A' });
  insertTemplateWithSpec(db, specId, { name: '模板B' });
  insertGroupMemberWithSpec(db, specId);

  const res = await app.inject({
    method: 'DELETE', url: `/api/v1/admin/specs/${specId}`, headers: ADMIN_HEADERS,
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.json().error.message, /已被 3 个套餐\/团购引用/);
});

test('删除规格：不存在时 404 SPEC_NOT_FOUND', async (t) => {
  const { app } = await makeApp(t);
  const res = await app.inject({
    method: 'DELETE', url: '/api/v1/admin/specs/999', headers: ADMIN_HEADERS,
  });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error.code, 'SPEC_NOT_FOUND');
});

test('删除规格：非管理员 401，不得删除', async (t) => {
  const { app, db } = await makeApp(t);
  const specId = insertSpec(db);
  const res = await app.inject({ method: 'DELETE', url: `/api/v1/admin/specs/${specId}` });
  assert.equal(res.statusCode, 401, res.body);
  assert.ok(db.get('SELECT id FROM specs WHERE id = ?', specId));
});

// ---------------------------------------------------------------- ② 公告 Notice

test('公告：未配置时公开接口返回 notice: null', async (t) => {
  const { app } = await makeApp(t);
  const res = await app.inject({ method: 'GET', url: '/api/v1/config/notice' });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { notice: null });
});

test('公告：生效中（activeFrom 已过、activeUntil 为空）公开可见', async (t) => {
  const { app, db } = await makeApp(t);
  const activeFrom = new Date(Date.now() - 3600_000).toISOString();
  const put = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/notice',
    headers: ADMIN_HEADERS,
    payload: { content: '  今日截单 18:00，冷链发货  ', activeFrom, activeUntil: null },
  });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(put.json().notice.content, '今日截单 18:00，冷链发货');
  assert.equal(put.json().notice.activeUntil, null);

  // 落库为三个 settings key
  assert.equal(db.get("SELECT value FROM settings WHERE key = 'notice.content'").value, '今日截单 18:00，冷链发货');
  assert.equal(db.get("SELECT value FROM settings WHERE key = 'notice.active_from'").value, activeFrom);
  assert.equal(db.get("SELECT value FROM settings WHERE key = 'notice.active_until'"), undefined);

  // 公开接口无需任何鉴权
  const res = await app.inject({ method: 'GET', url: '/api/v1/config/notice' });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), {
    notice: { content: '今日截单 18:00，冷链发货', activeFrom, activeUntil: null },
  });
});

test('公告：activeUntil 为未来时间时仍在生效窗口内', async (t) => {
  const { app } = await makeApp(t);
  const activeFrom = new Date(Date.now() - 3600_000).toISOString();
  const activeUntil = new Date(Date.now() + 3600_000).toISOString();
  await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/notice',
    headers: ADMIN_HEADERS,
    payload: { content: '窗口内公告', activeFrom, activeUntil },
  });
  const res = await app.inject({ method: 'GET', url: '/api/v1/config/notice' });
  assert.equal(res.json().notice.content, '窗口内公告');
  assert.equal(res.json().notice.activeUntil, activeUntil);
});

test('公告：未到 activeFrom 时公开接口返回 null（未生效）', async (t) => {
  const { app } = await makeApp(t);
  const activeFrom = new Date(Date.now() + 3600_000).toISOString();
  const put = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/notice',
    headers: ADMIN_HEADERS,
    payload: { content: '明天的公告', activeFrom, activeUntil: null },
  });
  assert.equal(put.statusCode, 200, put.body);
  const res = await app.inject({ method: 'GET', url: '/api/v1/config/notice' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { notice: null });
});

test('公告：已过 activeUntil 时公开接口返回 null（已过期）', async (t) => {
  const { app } = await makeApp(t);
  const activeFrom = new Date(Date.now() - 7200_000).toISOString();
  const activeUntil = new Date(Date.now() - 3600_000).toISOString();
  const put = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/notice',
    headers: ADMIN_HEADERS,
    payload: { content: '昨天的公告', activeFrom, activeUntil },
  });
  assert.equal(put.statusCode, 200, put.body);
  const res = await app.inject({ method: 'GET', url: '/api/v1/config/notice' });
  assert.deepEqual(res.json(), { notice: null });
});

test('公告：content 置空即下线；缺 activeFrom 422；非管理员 401', async (t) => {
  const { app, db } = await makeApp(t);
  const activeFrom = new Date(Date.now() - 3600_000).toISOString();
  await app.inject({
    method: 'PUT', url: '/api/v1/admin/notice', headers: ADMIN_HEADERS,
    payload: { content: '先上线一条', activeFrom, activeUntil: null },
  });
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/config/notice' })).json().notice.content, '先上线一条');

  const cleared = await app.inject({
    method: 'PUT', url: '/api/v1/admin/notice', headers: ADMIN_HEADERS,
    payload: { content: '', activeFrom, activeUntil: null },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/config/notice' })).json(), { notice: null });

  const missingFrom = await app.inject({
    method: 'PUT', url: '/api/v1/admin/notice', headers: ADMIN_HEADERS,
    payload: { content: '缺开始时间', activeUntil: null },
  });
  assert.equal(missingFrom.statusCode, 422, missingFrom.body);
  assert.equal(missingFrom.json().error.code, 'NOTICE_TIME_INVALID');

  const badFrom = await app.inject({
    method: 'PUT', url: '/api/v1/admin/notice', headers: ADMIN_HEADERS,
    payload: { content: '坏时间', activeFrom: '不是时间' },
  });
  assert.equal(badFrom.statusCode, 422, badFrom.body);

  const unauthorized = await app.inject({
    method: 'PUT', url: '/api/v1/admin/notice',
    payload: { content: '不该写入', activeFrom },
  });
  assert.equal(unauthorized.statusCode, 401, unauthorized.body);
  assert.equal(db.get("SELECT value FROM settings WHERE key = 'notice.content'"), undefined);
});

// ------------------------------------------------- ③ config/current 的 orderable

test('orderable：公蟹在 2026-10-01 00:00（北京时间）前为 false，之后为 true；母蟹恒 true', () => {
  assert.equal(MALE_ORDERABLE_FROM, '2026-10-01T00:00:00+08:00');
  const male = { gender: 'male' };
  const female = { gender: 'female' };

  assert.equal(isSpecOrderable(male, new Date('2026-09-30T23:59:59+08:00')), false);
  assert.equal(isSpecOrderable(male, new Date('2026-09-30T12:00:00+08:00')), false);
  assert.equal(isSpecOrderable(male, new Date('2026-10-01T00:00:00+08:00')), true);
  assert.equal(isSpecOrderable(male, new Date('2026-10-01T08:00:00+08:00')), true);

  assert.equal(isSpecOrderable(female, new Date('2026-09-30T12:00:00+08:00')), true);
  assert.equal(isSpecOrderable(female, new Date('2026-10-01T00:00:00+08:00')), true);
});

test('config/current：specs 携带 orderable（公蟹按当前时间判定、母蟹恒可下单）', async (t) => {
  const { app, db } = await makeApp(t);
  const batchId = insertBatch(db, { name: '当前批次' });
  const maleId = insertSpec(db, { batchId, gender: 'male', weightLabel: '4两', priceCents: 8800, sort: 1 });
  const femaleId = insertSpec(db, { batchId, gender: 'female', weightLabel: '3两', priceCents: 7800, sort: 2 });

  const res = await app.inject({ method: 'GET', url: '/api/v1/config/current' });
  assert.equal(res.statusCode, 200, res.body);
  const specs = res.json().specs;
  assert.equal(specs.length, 2);

  const male = specs.find((s) => s.id === maleId);
  const female = specs.find((s) => s.id === femaleId);
  // 两条都在（只是置灰，不做过滤）
  assert.equal(male.gender, 'male');
  assert.equal(female.gender, 'female');
  // 母蟹恒可下单
  assert.equal(female.orderable, true);
  // 公蟹与纯函数同口径（用真实时钟，避免用例过期）
  assert.equal(male.orderable, isSpecOrderable(male, new Date()));
  assert.equal(
    male.orderable,
    Date.now() >= Date.parse(MALE_ORDERABLE_FROM),
    '公蟹 orderable 应与 2026-10-01 00:00 北京时间对齐',
  );
});

test('config/current：无批次时 specs 为空数组（orderable 不影响空结构）', async (t) => {
  const { app } = await makeApp(t);
  const body = (await app.inject({ method: 'GET', url: '/api/v1/config/current' })).json();
  assert.equal(body.batch, null);
  assert.deepEqual(body.specs, []);
});
