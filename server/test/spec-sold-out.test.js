import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { isSpecOrderable, MALE_ORDERABLE_FROM } from '../src/repositories/configRepo.js';

// 本文件独占：spec-sold-out.test.js
// 覆盖「缺货开关」（specs.sold_out，迁移 008）：
//   ① 缺货的规格用户端不可下单，且优先级高于「公蟹开售日期」
//   ② 缺货 ≠ 停用：active 仍为 1，规格照常下发（看得见、买不了）
//   ③ 管理端可切换，非布尔值 422

const ADMIN_HEADERS = { authorization: 'Bearer dev-admin-token' };

async function makeApp(t) {
  const db = createDb(':memory:');
  const app = await buildApp({ db, env: {} });
  t.after(async () => { await app.close(); db.close(); });
  return { app, db };
}

function insertBatch(db) {
  return Number(db.run(
    "INSERT INTO batches (name, cutoff_time, status, created_at) VALUES (?, ?, 'open', ?)",
    '缺货测试批次',
    new Date(Date.now() + 3600_000).toISOString(),
    new Date().toISOString(),
  ).lastInsertRowid);
}

function insertSpec(db, {
  gender = 'female', weightLabel = '3两', priceCents = 2500, active = 1, soldOut = 0, batchId = null,
} = {}) {
  return Number(db.run(
    'INSERT INTO specs (batch_id, gender, weight_label, price_cents, active, sold_out, sort) VALUES (?, ?, ?, ?, ?, ?, 0)',
    batchId, gender, weightLabel, priceCents, active, soldOut,
  ).lastInsertRowid);
}

test('缺货规格：公母一律不可下单（缺货优先于性别）', () => {
  assert.equal(isSpecOrderable({ gender: 'female', soldOut: true }), false);
  assert.equal(isSpecOrderable({ gender: 'male', soldOut: true }), false);
});

test('缺货优先于「公蟹开售日期」：已到 10-01 也照样不可下单', () => {
  const afterOpen = new Date(MALE_ORDERABLE_FROM);
  afterOpen.setDate(afterOpen.getDate() + 1);
  assert.equal(isSpecOrderable({ gender: 'male', soldOut: false }, afterOpen), true, '有货+已开售 → 可下单');
  assert.equal(isSpecOrderable({ gender: 'male', soldOut: true }, afterOpen), false, '缺货 → 即使已开售也不可下单');
});

test('回归：未标缺货时行为与改动前一致', () => {
  const beforeOpen = new Date(MALE_ORDERABLE_FROM);
  beforeOpen.setDate(beforeOpen.getDate() - 1);
  assert.equal(isSpecOrderable({ gender: 'female', soldOut: false }, beforeOpen), true);
  assert.equal(isSpecOrderable({ gender: 'male', soldOut: false }, beforeOpen), false);
  assert.equal(isSpecOrderable(null), false, '不存在的规格不可下单');
});

test('config/current：缺货规格照常下发（看得见），但 orderable=false', async (t) => {
  const { app, db } = await makeApp(t);
  insertBatch(db);
  insertSpec(db, { gender: 'female', weightLabel: '3两', soldOut: 1 });
  insertSpec(db, { gender: 'female', weightLabel: '4两', soldOut: 0 });

  const res = await app.inject({ method: 'GET', url: '/api/v1/config/current' });
  assert.equal(res.statusCode, 200);
  const { specs } = res.json();
  const byWeight = Object.fromEntries(specs.map((s) => [s.weightLabel, s]));

  assert.equal(specs.length, 2, '缺货规格不能被过滤掉 —— 被过滤就成了「停用」而不是「缺货」');
  assert.equal(byWeight['3两'].soldOut, true);
  assert.equal(byWeight['3两'].orderable, false);
  assert.equal(byWeight['4两'].soldOut, false);
  assert.equal(byWeight['4两'].orderable, true);
});

test('停用(active=0)与缺货(sold_out=1)是两回事：停用不下发、缺货下发', async (t) => {
  const { app, db } = await makeApp(t);
  insertBatch(db);
  insertSpec(db, { gender: 'female', weightLabel: '3两', active: 0, soldOut: 0 }); // 停用
  insertSpec(db, { gender: 'female', weightLabel: '4两', active: 1, soldOut: 1 }); // 缺货

  const { specs } = (await app.inject({ method: 'GET', url: '/api/v1/config/current' })).json();
  assert.equal(specs.length, 1, '只有缺货那条会下发');
  assert.equal(specs[0].weightLabel, '4两');
  assert.equal(specs[0].orderable, false);
});

test('管理端可切换缺货：PUT /admin/specs/:id { soldOut: true } → 前台不可下单', async (t) => {
  const { app, db } = await makeApp(t);
  insertBatch(db);
  const specId = insertSpec(db, { gender: 'female', weightLabel: '3.5两' });

  const before = (await app.inject({ method: 'GET', url: '/api/v1/config/current' })).json();
  assert.equal(before.specs[0].orderable, true, '切换前可下单');

  const put = await app.inject({
    method: 'PUT',
    url: `/api/v1/admin/specs/${specId}`,
    headers: ADMIN_HEADERS,
    payload: { soldOut: true },
  });
  assert.equal(put.statusCode, 200);

  const after = (await app.inject({ method: 'GET', url: '/api/v1/config/current' })).json();
  assert.equal(after.specs[0].soldOut, true);
  assert.equal(after.specs[0].orderable, false, '切换后不可下单');
});

test('soldOut 传非布尔值 → 422', async (t) => {
  const { app, db } = await makeApp(t);
  const specId = insertSpec(db, {});
  const res = await app.inject({
    method: 'PUT',
    url: `/api/v1/admin/specs/${specId}`,
    headers: ADMIN_HEADERS,
    payload: { soldOut: 'yes' },
  });
  assert.equal(res.statusCode, 422);
});

const USER_HEADERS = { 'x-order-code': 'availuser' };
const SHIPPING = { recipient: '测试收件人', phone: '13800000000', address: '江苏省扬州市江都区测试路 1 号', packaging: 'gift' };
const OPEN_TIME = Date.parse(MALE_ORDERABLE_FROM);

async function availabilityFixture(t, gender = 'male') {
  t.mock.timers.enable({ apis: ['Date'], now: OPEN_TIME + 86_400_000 });
  const { app, db } = await makeApp(t);
  const batchId = insertBatch(db);
  db.run('UPDATE batches SET cutoff_time = ? WHERE id = ?', '2026-11-01T00:00:00Z', batchId);
  db.run("INSERT INTO users (order_code, display_name, status, created_at) VALUES (?, '测试用户', 'active', ?)", USER_HEADERS['x-order-code'], new Date().toISOString());
  const specId = insertSpec(db, { gender, batchId });
  db.run("INSERT INTO package_templates (id, name, packaging, active, created_at) VALUES (1, '测试预设套装', 'gift', 1, ?)", new Date().toISOString());
  db.run('INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (1, ?, 10)', specId);
  return { app, db, specId, items: [{ specId, qty: 10 }] };
}

function assertUnavailable(response) {
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json().error.code, 'SPEC_NOT_ORDERABLE');
}

test('开售判定同时支持数据库行、配置对象，停用与不存在规格不可售', () => {
  const now = new Date(OPEN_TIME);
  for (const spec of [null, { active: 0 }, { active: false }, { gender: 'female', sold_out: 1 }, { gender: 'male', soldOut: true }]) {
    assert.equal(isSpecOrderable(spec, now), false);
  }
  assert.equal(isSpecOrderable({ gender: 'male', active: 1, sold_out: 0 }, new Date(OPEN_TIME - 1)), false);
  assert.equal(isSpecOrderable({ gender: 'male', active: 1, sold_out: 0 }, now), true);
});

test('北京时间 10 月 1 日零点：API 在前一毫秒拒绝，零点配置与订单同步开售', async (t) => {
  const { app, items, specId } = await availabilityFixture(t);
  const request = { method: 'POST', url: '/api/v1/orders', headers: USER_HEADERS, payload: { idempotencyKey: 'boundary', shipments: [{ ...SHIPPING, items }] } };
  t.mock.timers.setTime(OPEN_TIME - 1);
  const configBefore = (await app.inject({ method: 'GET', url: '/api/v1/config/current' })).json();
  assert.equal(configBefore.specs.find((spec) => spec.id === specId).orderable, false);
  assertUnavailable(await app.inject(request));
  t.mock.timers.setTime(OPEN_TIME);
  const configAfter = (await app.inject({ method: 'GET', url: '/api/v1/config/current' })).json();
  assert.equal(configAfter.specs.find((spec) => spec.id === specId).orderable, true);
  const accepted = await app.inject(request);
  assert.equal(accepted.statusCode, 201, accepted.body);
});

for (const scenario of [
  { name: '公蟹未开售', gender: 'male', beforeOpen: true },
  { name: '公蟹缺货', gender: 'male', beforeOpen: false },
  { name: '母蟹缺货', gender: 'female', beforeOpen: false },
]) {
  test(`${scenario.name}：建团/增改成员/成团/自选/预设全部拒绝，历史订单与幂等不受影响`, async (t) => {
    const { app, db, specId, items } = await availabilityFixture(t, scenario.gender);
    const initialMember = { name: '团长', items };
    const createRequest = { method: 'POST', url: '/api/v1/groups', headers: USER_HEADERS, payload: { title: '可售校验团', initialMember } };
    const created = await app.inject(createRequest);
    assert.equal(created.statusCode, 200, created.body);
    const { token, member, editKey } = created.json();
    if (scenario.beforeOpen) t.mock.timers.setTime(OPEN_TIME - 1);
    else db.run('UPDATE specs SET sold_out = 1 WHERE id = ?', specId);

    assertUnavailable(await app.inject(createRequest));
    assert.equal(db.get('SELECT COUNT(*) AS n FROM groups').n, 1, '建团及附带意向必须原子回滚');
    assertUnavailable(await app.inject({ method: 'POST', url: `/api/v1/groups/${token}/members`, payload: { name: '成员', items } }));
    assertUnavailable(await app.inject({ method: 'PUT', url: `/api/v1/groups/${token}/members/${member.id}`, headers: { 'x-edit-key': editKey }, payload: { name: '改名', items } }));
    assert.equal(db.get('SELECT name FROM group_members WHERE id = ?', member.id).name, '团长');
    const group = (await app.inject({ method: 'GET', url: `/api/v1/groups/${token}` })).json();
    assert.equal(group.canSubmit, false);
    assert.equal(group.members[0].quantity, 10, '已存意向仍可查看和调整');

    const submit = { method: 'POST', url: `/api/v1/groups/${token}/submit`, headers: USER_HEADERS, payload: SHIPPING };
    assertUnavailable(await app.inject(submit));
    const personal = { method: 'POST', url: '/api/v1/orders', headers: USER_HEADERS, payload: { idempotencyKey: 'availability-personal', shipments: [{ ...SHIPPING, items }] } };
    assertUnavailable(await app.inject(personal));
    assertUnavailable(await app.inject({ ...personal, payload: { idempotencyKey: 'availability-template', shipments: [{ ...SHIPPING, templateId: 1, copies: 2 }] } }));
    assert.equal(db.get('SELECT COUNT(*) AS n FROM orders').n, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM shipments').n, 0);

    t.mock.timers.setTime(OPEN_TIME + 86_400_000);
    db.run('UPDATE specs SET sold_out = 0 WHERE id = ?', specId);
    const accepted = await app.inject(personal);
    assert.equal(accepted.statusCode, 201, accepted.body);
    const submitted = await app.inject(submit);
    assert.equal(submitted.statusCode, 200, submitted.body);
    db.run('UPDATE specs SET sold_out = 1, price_cents = 1 WHERE id = ?', specId);
    const replay = await app.inject(personal);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json().order, accepted.json().order);
    const groupReplay = await app.inject(submit);
    assert.equal(groupReplay.statusCode, 200, groupReplay.body);
    assert.equal(groupReplay.json().order.id, submitted.json().order.id);
    const history = await app.inject({ method: 'GET', url: `/api/v1/orders/${accepted.json().order.id}`, headers: USER_HEADERS });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.json().order.amount.crabCents, 25000);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM orders').n, 2);
  });
}
