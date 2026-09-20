import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';

const ADMIN = { authorization: 'Bearer dev-admin-token' };
const TS = '2026-09-19T01:00:00.000Z';

async function makeApp() {
  const db = createDb(':memory:');
  const app = await buildApp({ db });
  return { app, db };
}

function insertUser(db, id = 1) {
  db.run(
    "INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    id,
    `CODE${id}`,
    `用户${id}`,
    TS,
  );
}

function insertBatch(db, id, status = 'open', name = `批次${id}`) {
  db.run(
    'INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    name,
    new Date(Date.now() + 86_400_000).toISOString(),
    status,
    TS,
  );
}

function insertSpec(db, id, batchId, gender, weightLabel, priceCents = 1000) {
  db.run(
    'INSERT INTO specs (id, batch_id, gender, weight_label, price_cents) VALUES (?, ?, ?, ?, ?)',
    id,
    batchId,
    gender,
    weightLabel,
    priceCents,
  );
}

function insertOrder(db, {
  id,
  batchId = 1,
  seq,
  orderNo,
  userId = 1,
  source = 'personal',
  crabCents = 10000,
  packagingCents = 1000,
  freightCents = null,
  totalCents = null,
  deletedAt = null,
}) {
  db.run(
    `INSERT INTO orders
     (id, batch_id, seq, order_no, user_id, source, status, crab_cents, packaging_cents, freight_cents, total_cents, config_snapshot, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, '{}', ?, ?)`,
    id,
    batchId,
    seq,
    orderNo,
    userId,
    source,
    crabCents,
    packagingCents,
    freightCents,
    totalCents,
    TS,
    deletedAt,
  );
}

function insertShipment(db, {
  id,
  orderId,
  seq = 1,
  status = 'fishing',
  recipient = '张三',
  items = [{ gender: 'male', weightLabel: '4两', quantity: 5, priceCents: 1000 }],
  copies = 1,
  packaging = 'plain',
  crabCents = 10000,
  packagingCents = 1000,
}) {
  db.run(
    `INSERT INTO shipments
     (id, order_id, seq, recipient, phone, address, copies, packaging, items_json, crab_cents, packaging_cents, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '13800000000', '上海市黄浦区xx路1号', ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    orderId,
    seq,
    recipient,
    copies,
    packaging,
    JSON.stringify(items),
    crabCents,
    packagingCents,
    status,
    TS,
    TS,
  );
}

function insertGroup(db, { id, batchId = 1, orderId }) {
  db.run(
    `INSERT INTO groups (id, batch_id, leader_user_id, token, title, status, submitted_order_id, created_at)
     VALUES (?, ?, 1, ?, ?, 'submitted', ?, ?)`,
    id,
    batchId,
    `token${id}`,
    `拼团${id}`,
    orderId,
    TS,
  );
}

function insertMember(db, { id, groupId, name, specId = 1, quantity = 10, submittedOrder }) {
  db.run(
    `INSERT INTO group_members
     (id, group_id, name, spec_id, spec_snapshot, quantity, submitted_order, created_at)
     VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`,
    id,
    groupId,
    name,
    specId,
    quantity,
    submittedOrder,
    TS,
  );
}

test('summary: 缺省取最近截单 open 批次，汇总规格数量并排除已删除订单', async () => {
  const { app, db } = await makeApp();
  insertUser(db);
  insertBatch(db, 1, 'open');
  insertBatch(db, 2, 'open');
  db.run('UPDATE batches SET cutoff_time = ? WHERE id = 1', new Date(Date.now() + 2 * 86_400_000).toISOString());
  insertBatch(db, 3, 'closed');
  insertOrder(db, { id: 1, batchId: 2, seq: 1, orderNo: 'D260919-0001' });
  insertShipment(db, {
    id: 1,
    orderId: 1,
    items: [
      { gender: 'male', weightLabel: '4两', quantity: 5 },
      { gender: 'female', weightLabel: '3两', quantity: 5 },
    ],
  });
  insertOrder(db, { id: 2, batchId: 2, seq: 2, orderNo: 'D260919-0002' });
  insertShipment(db, {
    id: 2,
    orderId: 2,
    status: 'packed',
    items: [{ gender: 'male', weightLabel: '4两', quantity: 10 }],
  });
  // 已删除订单不计入
  insertOrder(db, {
    id: 3,
    batchId: 2,
    seq: 3,
    orderNo: 'D260919-0003',
    deletedAt: TS,
  });
  insertShipment(db, {
    id: 3,
    orderId: 3,
    items: [{ gender: 'male', weightLabel: '4两', quantity: 99 }],
  });

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/batch/summary',
    headers: ADMIN,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.batch.id, 2);
  assert.equal(body.orderCount, 2);
  assert.equal(body.shipmentCount, 2);
  assert.deepEqual(body.statusCounts, { fishing: 1, packed: 1, shipped: 0 });
  const male4 = body.totalsBySpec.find(
    (t) => t.gender === 'male' && t.weightLabel === '4两',
  );
  assert.equal(male4.quantity, 15);
  const female3 = body.totalsBySpec.find(
    (t) => t.gender === 'female' && t.weightLabel === '3两',
  );
  assert.equal(female3.quantity, 5);

  // 显式 batchId 与无批次场景
  const explicit = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/batch/summary?batchId=1',
    headers: ADMIN,
  });
  assert.equal(explicit.json().batch.id, 1);
  const bad = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/batch/summary?batchId=999',
    headers: ADMIN,
  });
  assert.equal(bad.statusCode, 404);

  await app.close();
  db.close();
});

test('shipments: 按 order.seq、shipment.seq 升序，排除已删除订单', async () => {
  const { app, db } = await makeApp();
  insertUser(db);
  insertBatch(db, 1);
  insertOrder(db, { id: 1, batchId: 1, seq: 2, orderNo: 'D260919-0002' });
  insertOrder(db, { id: 2, batchId: 1, seq: 1, orderNo: 'D260919-0001' });
  insertOrder(db, { id: 3, batchId: 1, seq: 0, orderNo: 'D260919-0000', deletedAt: TS });
  insertShipment(db, { id: 1, orderId: 1, seq: 2, recipient: '乙' });
  insertShipment(db, { id: 2, orderId: 1, seq: 1, recipient: '甲' });
  insertShipment(db, { id: 3, orderId: 2, seq: 1, recipient: '丙' });
  insertShipment(db, { id: 4, orderId: 3, seq: 1, recipient: '丁' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/shipments?batchId=1',
    headers: ADMIN,
  });
  assert.equal(res.statusCode, 200);
  const { shipments } = res.json();
  assert.deepEqual(
    shipments.map((s) => s.recipient),
    ['丙', '甲', '乙'],
  );
  assert.equal(shipments[0].orderNo, 'D260919-0001');
  assert.equal(shipments[0].source, 'personal');
  assert.equal(shipments[0].status, 'fishing');
  assert.equal(shipments[0].freightCents, null);
  assert.equal(shipments[0].actualWeightGrams, null);
  assert.equal(Array.isArray(shipments[0].items), true);

  await app.close();
  db.close();
});

test('transition: 合法推进/撤回、非法流转与重复推进 409，全部写审计', async () => {
  const { app, db } = await makeApp();
  insertUser(db);
  insertBatch(db, 1);
  insertOrder(db, { id: 1, seq: 1, orderNo: 'D260919-0001' });
  insertShipment(db, { id: 1, orderId: 1 });

  const go = (to) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/admin/shipments/1/transition',
      headers: ADMIN,
      payload: { to },
    });

  // fishing → packed
  assert.equal((await go('packed')).statusCode, 200);
  // 重复推进同一状态 → 409
  const repeat = await go('packed');
  assert.equal(repeat.statusCode, 409);
  assert.equal(repeat.json().error.code, 'INVALID_TRANSITION');
  // 未登记快递费不能直接跳到已发货
  const withoutFreight = await go('shipped');
  assert.equal(withoutFreight.statusCode, 409);
  assert.equal(withoutFreight.json().error.code, 'FREIGHT_REQUIRED');
  const shortcut = await app.inject({ method: 'POST', url: '/api/v1/admin/shipments/1/ship', headers: ADMIN });
  assert.equal(shortcut.statusCode, 409);
  assert.equal(shortcut.json().error.code, 'FREIGHT_REQUIRED');
  // 已打包可撤回捕捞中
  assert.equal((await go('fishing')).statusCode, 200);
  // fishing 不能撤回到不存在的上一态，也不能跳级发货
  assert.equal((await go('shipped')).statusCode, 409);
  await go('packed');
  // 提交快递费后自动从已打包变为已发货
  const freight = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/freight',
    headers: ADMIN,
    payload: { weightGrams: 2400, freightCents: 1200 },
  });
  assert.equal(freight.statusCode, 200);
  assert.equal(freight.json().shipment.status, 'shipped');
  // ship 快捷标记仍要求已有快递费，已发货订单不可重复推进
  const shipped = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/ship',
    headers: ADMIN,
  });
  assert.equal(shipped.statusCode, 409);
  // shipped 是终态，不能撤回
  const again = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/ship',
    headers: ADMIN,
  });
  assert.equal(again.statusCode, 409);
  // 非法目标状态 → 400
  const badTo = await go('nowhere');
  assert.equal(badTo.statusCode, 400);

  const audits = db.all(
    "SELECT * FROM audit_logs WHERE entity = 'shipment' AND entity_id = 1 AND action = 'shipment.transition'",
  );
  assert.equal(audits.length, 4);
  await app.close();
  db.close();
});

test('freight(个人): 打包后录入→自动发货→订单总额更新，已发货不可清空', async () => {
  const { app, db } = await makeApp();
  insertUser(db);
  insertBatch(db, 1);
  insertOrder(db, {
    id: 1,
    seq: 1,
    orderNo: 'D260919-0001',
    crabCents: 10000,
    packagingCents: 1000,
  });
  insertShipment(db, { id: 1, orderId: 1 });

  // 先完成打包；捕捞中不能提前登记快递费
  const early = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/freight',
    headers: ADMIN,
    payload: { weightGrams: 2750, freightCents: 1200 },
  });
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().error.code, 'PACKING_REQUIRED');
  await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/transition',
    headers: ADMIN,
    payload: { to: 'packed' },
  });

  // 录入重量 + 运费
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/freight',
    headers: ADMIN,
    payload: { weightGrams: 2750, freightCents: 1200 },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.shipment.status, 'shipped');
  assert.equal(body.shipment.actualWeightGrams, 2750);
  assert.equal(body.shipment.freightCents, 1200);
  assert.equal(body.order.freightCents, 1200);
  assert.equal(body.order.totalCents, 10000 + 1000 + 1200);

  // 修改
  const edited = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/freight',
    headers: ADMIN,
    payload: { weightGrams: 2800, freightCents: 1500 },
  });
  assert.equal(edited.json().order.totalCents, 12500);

  // 已发货后不允许清空运费
  const cleared = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/freight',
    headers: ADMIN,
    payload: { weightGrams: 2800, freightCents: null },
  });
  assert.equal(cleared.statusCode, 409);
  assert.equal(cleared.json().error.code, 'FREIGHT_REQUIRED');
  assert.equal(db.get('SELECT freight_cents FROM shipments WHERE id = 1').freight_cents, 1500);
  assert.equal(db.get('SELECT total_cents FROM orders WHERE id = 1').total_cents, 12500);

  const freightAudits = db.all(
    "SELECT * FROM audit_logs WHERE action = 'shipment.freight' AND entity_id = 1",
  );
  assert.equal(freightAudits.length, 2);

  await app.close();
  db.close();
});

test('freight(拼团): 包装费 + 运费合并分摊、余数直接抹零、人工改价不再归集给团长', async () => {
  const { app, db } = await makeApp();
  insertUser(db);
  insertBatch(db, 1);
  insertSpec(db, 1, 1, 'male', '4两');
  insertOrder(db, {
    id: 1,
    seq: 1,
    orderNo: 'D260919-0001',
    source: 'group',
    crabCents: 30000,
    packagingCents: 3000,
  });
  insertShipment(db, { id: 1, orderId: 1, crabCents: 30000, packagingCents: 3000 });
  await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/transition',
    headers: ADMIN,
    payload: { to: 'packed' },
  });
  insertGroup(db, { id: 1, orderId: 1 });
  insertMember(db, { id: 11, groupId: 1, name: '团长', submittedOrder: 1 });
  insertMember(db, { id: 12, groupId: 1, name: '成员二', submittedOrder: 2 });
  insertMember(db, { id: 13, groupId: 1, name: '成员三', submittedOrder: 3 });

  // 等重 + 不能整除的总运费：包装费 3000 + 运费 1000 合并成 4000 一次分完，
  // 两人份各 1333，除不尽的零头直接抹零（平台承担），不再补给前几名。
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/freight',
    headers: ADMIN,
    payload: {
      totalFreightCents: 1000,
      memberWeights: [
        { memberId: 11, weightGrams: 100 },
        { memberId: 12, weightGrams: 100 },
        { memberId: 13, weightGrams: 100 },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  let members = res.json().members;
  let shares = members.map((m) => m.freightShareCents);
  assert.deepEqual(shares, [333, 333, 333]); // 运费分摊：floor(1000/3)，1 分抹零
  assert.equal(shares.reduce((a, b) => a + b, 0), 999); // <= 1000，不补齐
  // 合并均摊：包装费行 + 运费行 = 该成员实际分摊到的那一份（合并总额 4000 / 3 → 1333）
  assert.deepEqual(members.map((m) => m.packagingShareCents), [1000, 1000, 1000]);
  for (const m of members) {
    assert.equal(m.packagingShareCents + m.freightShareCents, 1333);
  }
  assert.equal(res.json().shipment.freightCents, 1000);
  assert.equal(res.json().shipment.status, 'shipped');
  assert.equal(res.json().order.freightCents, 1000);
  assert.equal(res.json().order.totalCents, 30000 + 3000 + 1000);

  // 人工改价：成员二改为 100 分；差额由平台承担，不再归集给团长
  const adjusted = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/freight',
    headers: ADMIN,
    payload: {
      totalFreightCents: 1000,
      memberWeights: [
        { memberId: 11, weightGrams: 100 },
        { memberId: 12, weightGrams: 100 },
        { memberId: 13, weightGrams: 100 },
      ],
      adjustments: [{ memberId: 12, freightCents: 100, reason: '少发一只' }],
    },
  });
  assert.equal(adjusted.statusCode, 200);
  members = adjusted.json().members;
  shares = members.map((m) => m.freightShareCents);
  assert.equal(shares.reduce((a, b) => a + b, 0), 766); // <= 运费 + 包装费 4000
  assert.equal(shares[1], 100);
  assert.equal(shares[0], 333); // 团长不再被补差额
  assert.equal(members[1].freightAdjusted, true);
  assert.equal(members[1].adjustReason, '少发一只');
  assert.equal(members[0].freightAdjusted, false);

  // 改价无 reason → 400
  const noReason = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/freight',
    headers: ADMIN,
    payload: {
      totalFreightCents: 1000,
      memberWeights: [
        { memberId: 11, weightGrams: 100 },
        { memberId: 12, weightGrams: 100 },
        { memberId: 13, weightGrams: 100 },
      ],
      adjustments: [{ memberId: 12, freightCents: 100 }],
    },
  });
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.json().error.code, 'ADJUST_REASON_REQUIRED');

  // 审计：shipment.freight + 每次人工修正
  const freightAudit = db.all(
    "SELECT * FROM audit_logs WHERE action = 'shipment.freight' AND entity_id = 1",
  );
  assert.equal(freightAudit.length, 2);
  const adjustAudit = db.all(
    "SELECT * FROM audit_logs WHERE action = 'member.freight_adjust' AND entity_id = 12",
  );
  assert.equal(adjustAudit.length, 1);
  const detail = JSON.parse(adjustAudit[0].detail);
  assert.equal(detail.freightCents, 100);
  assert.equal(detail.reason, '少发一只');

  await app.close();
  db.close();
});

test('delete: 软删除后 summary/shipments 不计，再删 409，审计含金额快照', async () => {
  const { app, db } = await makeApp();
  insertUser(db);
  insertBatch(db, 1);
  insertOrder(db, {
    id: 1,
    seq: 1,
    orderNo: 'D260919-0001',
    crabCents: 10000,
    packagingCents: 1000,
    freightCents: 1200,
    totalCents: 12200,
  });
  insertShipment(db, { id: 1, orderId: 1 });

  const res = await app.inject({
    method: 'DELETE',
    url: '/api/v1/admin/orders/1',
    headers: ADMIN,
    payload: { reason: '用户取消' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().deleted, true);
  assert.notEqual(db.get('SELECT deleted_at FROM orders WHERE id = 1').deleted_at, null);

  const summary = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/batch/summary',
    headers: ADMIN,
  });
  assert.equal(summary.json().orderCount, 0);
  assert.equal(summary.json().shipmentCount, 0);
  assert.deepEqual(summary.json().totalsBySpec, []);

  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/shipments',
    headers: ADMIN,
  });
  assert.equal(list.json().shipments.length, 0);

  // 再删 409
  const again = await app.inject({
    method: 'DELETE',
    url: '/api/v1/admin/orders/1',
    headers: ADMIN,
    payload: { reason: '重复操作' },
  });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, 'ORDER_ALREADY_DELETED');

  // 不存在的订单 404
  const missing = await app.inject({
    method: 'DELETE',
    url: '/api/v1/admin/orders/999',
    headers: ADMIN,
  });
  assert.equal(missing.statusCode, 404);

  // 审计：操作者、订单号、金额快照、原因
  const audit = db.get(
    "SELECT * FROM audit_logs WHERE action = 'order.delete' AND entity_id = 1",
  );
  assert.equal(audit.actor_type, 'admin');
  assert.equal(audit.actor_id, 0); // env admin
  const detail = JSON.parse(audit.detail);
  assert.equal(detail.orderNo, 'D260919-0001');
  assert.equal(detail.reason, '用户取消');
  assert.deepEqual(detail.amountSnapshot, {
    crabCents: 10000,
    packagingCents: 1000,
    freightCents: 1200,
    totalCents: 12200,
  });

  await app.close();
  db.close();
});

test('软删除后不能继续推进发货单或修改运费', async () => {
  const { app, db } = await makeApp();
  insertUser(db);
  insertBatch(db, 1);
  insertOrder(db, { id: 1, seq: 1, orderNo: 'D260919-0001' });
  insertShipment(db, { id: 1, orderId: 1 });

  const deleted = await app.inject({
    method: 'DELETE',
    url: '/api/v1/admin/orders/1',
    headers: ADMIN,
    payload: { reason: '重复订单' },
  });
  assert.equal(deleted.statusCode, 200);

  const transition = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/transition',
    headers: ADMIN,
    payload: { to: 'packed' },
  });
  assert.equal(transition.statusCode, 409);
  assert.equal(transition.json().error.code, 'ORDER_DELETED');

  const freight = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/freight',
    headers: ADMIN,
    payload: { weightGrams: 1000, freightCents: 1200 },
  });
  assert.equal(freight.statusCode, 409);
  assert.equal(freight.json().error.code, 'ORDER_DELETED');
  assert.equal(db.get('SELECT status FROM shipments WHERE id = 1').status, 'fishing');

  await app.close();
  db.close();
});

test('audit-logs: 按 entity/entityId 过滤查询', async () => {
  const { app, db } = await makeApp();
  insertUser(db);
  insertBatch(db, 1);
  insertOrder(db, { id: 1, seq: 1, orderNo: 'D260919-0001' });
  insertOrder(db, { id: 2, seq: 2, orderNo: 'D260919-0002' });
  insertShipment(db, { id: 1, orderId: 1 });

  await app.inject({
    method: 'POST',
    url: '/api/v1/admin/shipments/1/transition',
    headers: ADMIN,
    payload: { to: 'packed' },
  });
  await app.inject({
    method: 'DELETE',
    url: '/api/v1/admin/orders/2',
    headers: ADMIN,
    payload: { reason: '测试' },
  });

  const all = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/audit-logs',
    headers: ADMIN,
  });
  assert.equal(all.json().auditLogs.length, 2);

  const byEntity = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/audit-logs?entity=order&entityId=2',
    headers: ADMIN,
  });
  const logs = byEntity.json().auditLogs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'order.delete');
  assert.equal(logs[0].detail.reason, '测试');

  await app.close();
  db.close();
});

test('auth: 无 token 一律 401', async () => {
  const { app, db } = await makeApp();
  insertUser(db);
  insertBatch(db, 1);
  insertOrder(db, { id: 1, seq: 1, orderNo: 'D260919-0001' });
  insertShipment(db, { id: 1, orderId: 1 });

  const calls = [
    { method: 'GET', url: '/api/v1/admin/batch/summary' },
    { method: 'GET', url: '/api/v1/admin/shipments' },
    { method: 'POST', url: '/api/v1/admin/shipments/1/transition', payload: { to: 'packed' } },
    { method: 'POST', url: '/api/v1/admin/shipments/1/freight', payload: { weightGrams: 1, freightCents: 1 } },
    { method: 'POST', url: '/api/v1/admin/shipments/1/ship' },
    { method: 'DELETE', url: '/api/v1/admin/orders/1' },
    { method: 'GET', url: '/api/v1/admin/audit-logs' },
  ];
  for (const c of calls) {
    const res = await app.inject({ method: c.method, url: c.url, payload: c.payload });
    assert.equal(res.statusCode, 401, `${c.method} ${c.url} 应返回 401`);
  }

  // 状态未被未授权请求改变
  assert.equal(db.get('SELECT status FROM shipments WHERE id = 1').status, 'fishing');
  assert.equal(db.get('SELECT deleted_at FROM orders WHERE id = 1').deleted_at, null);

  await app.close();
  db.close();
});

test('逐地址发货：运费留空不发货，0 元有效，其他地址保持原状态', async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  insertUser(db);
  insertBatch(db, 1);
  insertOrder(db, { id: 1, seq: 1, orderNo: 'D260919-0001', crabCents: 20000, packagingCents: 2000 });
  insertShipment(db, { id: 1, orderId: 1, seq: 1, status: 'packed' });
  insertShipment(db, { id: 2, orderId: 1, seq: 2, status: 'packed' });
  const freight = (id, value) => app.inject({
    method: 'POST', url: `/api/v1/admin/shipments/${id}/freight`, headers: ADMIN,
    payload: { weightGrams: 1000, freightCents: value },
  });
  for (const value of [null, undefined]) {
    const rejected = await freight(1, value);
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().error.code, 'FREIGHT_REQUIRED');
    assert.equal(db.get('SELECT status FROM shipments WHERE id = 1').status, 'packed');
  }
  const first = await freight(1, 0);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().shipment.status, 'shipped');
  assert.equal(first.json().shipment.freightCents, 0);
  assert.equal(first.json().order.freightCents, null);
  assert.equal(db.get('SELECT status FROM shipments WHERE id = 2').status, 'packed');
  const second = await freight(2, 1800);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().shipment.status, 'shipped');
  assert.equal(second.json().order.freightCents, 1800);
  assert.equal(second.json().order.totalCents, 23800);
});

test('仅填个人运费即可发货和修改，未填写实重保持为空', async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  insertUser(db);
  insertBatch(db, 1);
  insertOrder(db, { id: 1, seq: 1, orderNo: 'D260919-0001' });
  insertShipment(db, { id: 1, orderId: 1, status: 'packed' });
  for (const freightCents of [1200, 1800, 0]) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/shipments/1/freight', headers: ADMIN, payload: { freightCents } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().shipment.status, 'shipped');
    assert.equal(response.json().shipment.actualWeightGrams, null);
    assert.equal(response.json().order.freightCents, freightCents);
    assert.equal(response.json().order.totalCents, 11000 + freightCents);
  }
});

test('仅填拼团运费：按成员历史混合规格标重分摊，中文半两、余数、0及修改守恒', async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  insertUser(db);
  insertBatch(db, 1);
  insertSpec(db, 1, 1, 'male', '5两');
  insertSpec(db, 2, 1, 'female', '5两');
  insertOrder(db, { id: 1, seq: 1, orderNo: 'D260919-0001', source: 'group' });
  insertShipment(db, { id: 1, orderId: 1, status: 'packed' });
  insertGroup(db, { id: 1, orderId: 1 });
  insertMember(db, { id: 11, groupId: 1, name: '甲', quantity: 5, submittedOrder: 1 });
  insertMember(db, { id: 12, groupId: 1, name: '乙', quantity: 5, submittedOrder: 2 });
  // 甲 2×200+3×175=925g，乙 5×150=750g；当前规格改到5两不影响历史比例。
  db.run('UPDATE group_members SET spec_snapshot = ? WHERE id = 11', JSON.stringify({ items: [
    { specId: 1, gender: 'male', weightLabel: '四两', qty: 2 },
    { specId: 2, gender: 'female', weightLabel: '三两半', qty: 3 },
  ] }));
  db.run('UPDATE group_members SET spec_snapshot = ? WHERE id = 12', JSON.stringify({ specId: 1, gender: 'male', weightLabel: '3两' }));
  const save = (payload) => app.inject({ method: 'POST', url: '/api/v1/admin/shipments/1/freight', headers: ADMIN, payload });
  const first = await save({ totalFreightCents: 1001 });
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().members.map((m) => m.freightShareCents), [553, 448]);
  assert.equal(first.json().shipment.status, 'shipped');
  assert.equal(first.json().shipment.actualWeightGrams, null);
  assert.ok(first.json().members.every((m) => m.actualWeightGrams === null));
  const edited = await save({ freightCents: 1675 });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.deepEqual(edited.json().members.map((m) => m.freightShareCents), [925, 750]);
  const free = await save({ totalFreightCents: 0 });
  assert.deepEqual(free.json().members.map((m) => m.freightShareCents), [0, 0]);
  assert.equal(free.json().order.freightCents, 0);
  const audit = db.get("SELECT detail FROM audit_logs WHERE action = 'shipment.freight' ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(audit.detail).weightSource, 'specification');
  // 无法识别历史重量时不默默均分，也不留下部分金额更新。
  db.run('UPDATE group_members SET spec_snapshot = ? WHERE id = 12', JSON.stringify({ specId: 1, weightLabel: '大号' }));
  const invalid = await save({ totalFreightCents: 1000 });
  assert.equal(invalid.statusCode, 422);
  assert.equal(db.get('SELECT freight_cents FROM shipments WHERE id = 1').freight_cents, 0);
  assert.equal(db.get('SELECT freight_share_cents FROM group_members WHERE id = 11').freight_share_cents, 0);
});
