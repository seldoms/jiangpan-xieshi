import './helpers/selling-season.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { ensureDailyBatch } from '../src/repositories/dailyBatchRepo.js';
import { listActiveSpecsForBatch } from '../src/repositories/configRepo.js';

const ADMIN = { authorization: 'Bearer dev-admin-token' };
const USER = { 'x-order-code': 'dailyuser' };

function fixture(t, cutoff = '2026-12-31T09:00:00.000Z') {
  const db = createDb(':memory:');
  t.after(() => db.close());
  db.run("INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (1, '首批', ?, 'open', ?)", cutoff, cutoff);
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (1, 1, 'male', '4两', 200, 1, 0)");
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (2, NULL, 'female', '3两', 300, 1, 1)");
  db.run("INSERT INTO package_templates (id, name, packaging, active, created_at) VALUES (1, '全公', 'plain', 1, ?)", cutoff);
  db.run('INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (1, 1, 10)');
  db.run("INSERT INTO package_templates (id, name, packaging, active, created_at) VALUES (2, '全母', 'plain', 1, ?)", cutoff);
  db.run('INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (2, 2, 10)');
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (1, 'dailyuser', '测试', 'active', ?)", cutoff);
  return db;
}

test('每日批次：截单边界、跨年、重复执行、停机多天恢复及目录继承', (t) => {
  const db = fixture(t);
  assert.equal(ensureDailyBatch(db, new Date('2026-12-31T08:59:59.999Z')).id, 1);
  const next = ensureDailyBatch(db, new Date('2026-12-31T09:00:00.000Z'));
  assert.equal(next.cutoff_time, '2027-01-01T09:00:00.000Z');
  assert.match(next.name, /2027-01-01/);
  assert.equal(ensureDailyBatch(db, new Date('2026-12-31T09:00:00.000Z')).id, next.id);
  assert.equal(db.get('SELECT count(*) n FROM batches').n, 2);
  const afterDowntime = ensureDailyBatch(db, new Date('2027-01-05T10:00:00.000Z'));
  assert.equal(afterDowntime.cutoff_time, '2027-01-06T09:00:00.000Z');
  assert.deepEqual(listActiveSpecsForBatch(db, afterDowntime.id).map((s) => s.id), [1, 2]);
  assert.equal(db.get('SELECT count(*) n FROM batches').n, 3);
});

test('旧预建空目录及已续批的空关联按时间向前继承，停用规格不复活且不读取未来目录', (t) => {
  const db = fixture(t, '2026-09-19T09:00:00.000Z');
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (3, 1, 'male', '3两半', 100, 0, 2)");
  db.run("INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (2, '旧预建20日', '2026-09-20T09:00:00.000Z', 'closed', '2026-09-19T01:00:00.000Z')");
  db.run("INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (3, '旧续批21日', '2026-09-21T09:00:00.000Z', 'open', '2026-09-20T09:00:00.000Z')");
  db.run("INSERT INTO settings (key, value) VALUES ('batch.3.catalog_batches', '[]')");
  db.run("INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (4, '未来23日', '2026-09-23T09:00:00.000Z', 'open', '2026-09-19T01:00:00.000Z')");
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (4, 4, 'male', '5两', 500, 1, 3)");
  for (const batchId of [2, 3]) {
    assert.deepEqual(listActiveSpecsForBatch(db, batchId).map((s) => s.id), [1, 2]);
  }
  const next = ensureDailyBatch(db, new Date('2026-09-21T09:00:00.000Z'));
  assert.equal(next.cutoff_time, '2026-09-22T09:00:00.000Z');
  assert.deepEqual(listActiveSpecsForBatch(db, next.id).map((s) => s.id), [1, 2]);
  // 自身目录明确停用时不恢复更早批次；全局规格仍可独立在售。
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (5, 2, 'female', '4两', 400, 0, 4)");
  assert.deepEqual(listActiveSpecsForBatch(db, 2).map((s) => s.id), [2]);
  assert.deepEqual(listActiveSpecsForBatch(db, 3).map((s) => s.id), [2]);
  assert.equal(db.get("SELECT value FROM settings WHERE key = 'batch.3.catalog_batches'").value, '[]');
});

test('历史 ISO 时区/小数秒格式使用同一真实时间比较', (t) => {
  const db = fixture(t, '2026-12-31T17:00:00+08:00');
  assert.equal(ensureDailyBatch(db, new Date('2026-12-31T08:59:59.999Z')).id, 1);
  const next = ensureDailyBatch(db, new Date('2026-12-31T09:00:00Z'));
  assert.equal(next.cutoff_time, '2027-01-01T09:00:00.000Z');
  db.run('UPDATE batches SET cutoff_time = ? WHERE id = ?', '2027-01-01T09:00:00Z', next.id);
  assert.equal(ensureDailyBatch(db, new Date('2027-01-01T09:00:00.000Z')).cutoff_time, '2027-01-02T09:00:00.000Z');
});

test('预建隔三天批次仍逐日发布中间日期，目录沿用当日而非远期批次', (t) => {
  const db = fixture(t, '2026-09-19T09:00:00.000Z');
  db.run("INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (2, '预建22日', '2026-09-22T09:00:00.000Z', 'open', '2026-09-19T01:00:00.000Z')");
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (3, 2, 'male', '5两', 500, 1, 2)");
  assert.equal(ensureDailyBatch(db, new Date('2026-09-19T08:59:59.999Z')).id, 1);
  const tomorrow = ensureDailyBatch(db, new Date('2026-09-19T09:00:00.000Z'));
  assert.equal(tomorrow.cutoff_time, '2026-09-20T09:00:00.000Z');
  assert.deepEqual(listActiveSpecsForBatch(db, tomorrow.id).map((s) => s.id), [1, 2]);
  assert.equal(ensureDailyBatch(db, new Date('2026-09-19T09:00:01.000Z')).id, tomorrow.id);
  const day21 = ensureDailyBatch(db, new Date('2026-09-20T09:00:00.000Z'));
  assert.equal(day21.cutoff_time, '2026-09-21T09:00:00.000Z');
  assert.deepEqual(listActiveSpecsForBatch(db, day21.id).map((s) => s.id), [1, 2]);
  assert.equal(ensureDailyBatch(db, new Date('2026-09-21T09:00:00.000Z')).id, 2);
  assert.equal(db.get('SELECT count(*) n FROM batches').n, 4);
});

test('提前关闭预建远期批次不使当前续批跳日，仅有未来首批不补过去日期', (t) => {
  const db = fixture(t, '2026-09-22T09:00:00.000Z');
  assert.equal(ensureDailyBatch(db, new Date('2026-09-19T01:00:00.000Z')).id, 1);
  assert.equal(db.get('SELECT count(*) n FROM batches').n, 1);
  db.run("UPDATE batches SET status = 'closed' WHERE id = 1");
  db.run("INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (2, '当日', '2026-09-19T09:00:00.000Z', 'open', '2026-09-19T01:00:00.000Z')");
  assert.equal(ensureDailyBatch(db, new Date('2026-09-19T08:00:00.000Z')).id, 2);
  assert.equal(ensureDailyBatch(db, new Date('2026-09-19T09:00:00.000Z')).cutoff_time, '2026-09-20T09:00:00.000Z');
  assert.equal(db.get('SELECT status FROM batches WHERE id = 1').status, 'closed');
});

test('未来预建批次不会抢占当前批次，同配送日重复创建/修改被拒', async (t) => {
  const firstCutoff = new Date(Date.now() + 3_600_000).toISOString();
  const db = fixture(t, firstCutoff);
  const app = await buildApp({ db });
  const create = (name, cutoffTime) => app.inject({ method: 'POST', url: '/api/v1/admin/batches', headers: ADMIN, payload: { name, cutoffTime } });
  assert.equal((await create('重复日期', firstCutoff)).statusCode, 409);
  const tomorrow = await create('预建明日', new Date(new Date(firstCutoff).getTime() + 86_400_000).toISOString());
  assert.equal(tomorrow.statusCode, 201);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/config/current' })).json().batch.id, 1);
  const collision = await app.inject({ method: 'PUT', url: '/api/v1/admin/batches/2', headers: ADMIN, payload: { cutoffTime: firstCutoff } });
  assert.equal(collision.statusCode, 409);
  const advanced = ensureDailyBatch(db, new Date(firstCutoff));
  assert.equal(advanced.id, 2);
  assert.deepEqual(listActiveSpecsForBatch(db, 2).map((s) => s.id), [1, 2]);
  assert.equal(db.get('SELECT count(*) n FROM batches').n, 2);
  await app.close();
});

test('提前手动截单原子发布下一批，旧拼团读得到但增改删/提交均拒绝', async (t) => {
  const db = fixture(t, new Date(Date.now() + 3_600_000).toISOString());
  const app = await buildApp({ db });
  const group = (await app.inject({ method: 'POST', url: '/api/v1/groups', headers: USER, payload: {
    title: '截单边界', initialMember: { name: '团长', items: [{ specId: 1, qty: 10 }] },
  } })).json();
  const beforeCutoff = db.get('SELECT cutoff_time FROM batches WHERE id = 1').cutoff_time;
  const close = await app.inject({ method: 'POST', url: '/api/v1/admin/batches/1/close', headers: ADMIN });
  assert.equal(close.statusCode, 200);
  const next = db.get("SELECT * FROM batches WHERE status = 'open'");
  assert.equal(new Date(next.cutoff_time) - new Date(beforeCutoff), 86_400_000);
  const base = `/api/v1/groups/${group.token}`;
  for (const request of [
    { method: 'POST', url: `${base}/members`, payload: { name: '后来', items: [{ specId: 1, qty: 1 }] } },
    { method: 'PUT', url: `${base}/members/${group.member.id}`, headers: { 'x-edit-key': group.editKey }, payload: { name: '改名' } },
    { method: 'DELETE', url: `${base}/members/${group.member.id}`, headers: { 'x-edit-key': group.editKey } },
    { method: 'POST', url: `${base}/submit`, headers: USER, payload: { recipient: '测试', phone: '13800000000', address: '示例路1号' } },
  ]) {
    const result = await app.inject(request);
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, 'CUTOFF_PASSED');
  }
  const view = (await app.inject({ method: 'GET', url: base })).json();
  assert.equal(view.isAfterCutoff, true);
  assert.equal(view.members[0].name, '团长');
  assert.equal(view.totalCount, 10);
  await app.close();
});

test('批次截单可编辑，后续日期继承新时分，历史批次禁止修改', async (t) => {
  const db = fixture(t, new Date(Date.now() + 86_400_000).toISOString());
  const app = await buildApp({ db });
  const cutoffTime = new Date(Date.now() + 90_000_000).toISOString();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/batches/1', payload: { cutoffTime } })).statusCode, 401);
  const edited = await app.inject({ method: 'PUT', url: '/api/v1/admin/batches/1', headers: ADMIN, payload: { cutoffTime } });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().batch.cutoffTime, cutoffTime);
  const next = ensureDailyBatch(db, new Date(cutoffTime));
  assert.equal(new Date(next.cutoff_time) - new Date(cutoffTime), 86_400_000);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/batches/1', headers: ADMIN, payload: { cutoffTime } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/admin/batches/${next.id}`, headers: ADMIN, payload: { cutoffTime: 'invalid' } })).statusCode, 422);
  await app.close();
});

test('跨批次下单继承套餐规格，已下单幂等重试保持原订单和价格快照', async (t) => {
  const db = fixture(t, new Date(Date.now() + 3_600_000).toISOString());
  const app = await buildApp({ db });
  const payload = { idempotencyKey: 'daily-first', shipments: [{ recipient: '测试', phone: '13800000000', address: '示例路1号', templateId: 1, copies: 1 }] };
  const post = () => app.inject({ method: 'POST', url: '/api/v1/orders', headers: USER, payload });
  const first = await post();
  assert.equal(first.statusCode, 201);
  db.run('UPDATE batches SET cutoff_time = ? WHERE id = 1', new Date(Date.now() - 1).toISOString());
  db.run('UPDATE specs SET price_cents = 400 WHERE id = 1');
  const retry = await post();
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().order.id, first.json().order.id);
  assert.equal(retry.json().order.amount.crabCents, 2000);
  payload.idempotencyKey = 'daily-next';
  const next = await post();
  assert.equal(next.statusCode, 201);
  assert.equal(next.json().order.batchId, 2);
  assert.equal(next.json().order.amount.crabCents, 4000);
  assert.equal(db.get('SELECT count(*) n FROM orders').n, 2);
  await app.close();
});

test('规格和套餐排序原子持久化，缺项、重复、无权限均拒绝', async (t) => {
  const db = fixture(t, new Date(Date.now() + 3_600_000).toISOString());
  const app = await buildApp({ db });
  for (const kind of ['specs', 'package-templates']) {
    const url = `/api/v1/admin/${kind}/reorder`;
    assert.equal((await app.inject({ method: 'PUT', url, payload: { ids: [2, 1] } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'PUT', url, headers: ADMIN, payload: { ids: [1, 1] } })).statusCode, 422);
    assert.equal((await app.inject({ method: 'PUT', url, headers: ADMIN, payload: { ids: [2] } })).statusCode, 409);
    const sorted = await app.inject({ method: 'PUT', url, headers: ADMIN, payload: { ids: [2, 1] } });
    assert.equal(sorted.statusCode, 200);
    assert.deepEqual((sorted.json().specs ?? sorted.json().templates).map((s) => s.id), [2, 1]);
    const listed = await app.inject({ method: 'GET', url: `/api/v1/admin/${kind}`, headers: ADMIN });
    assert.deepEqual((listed.json().specs ?? listed.json().templates).map((s) => s.id), [2, 1]);
  }
  const current = (await app.inject({ method: 'GET', url: '/api/v1/config/current' })).json();
  assert.deepEqual(current.specs.map((s) => s.id), [2, 1]);
  assert.deepEqual(current.templates.map((s) => s.id), [2, 1]);
  await app.close();
});
