import './helpers/selling-season.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';

const USER_A = { 'x-order-code': 'codeusera' };
const USER_B = { 'x-order-code': 'codeuserb' };

/** 与 orderRepo.formatOrderDateCode 相同的口径，用于断言订单号日期段。 */
function expectedDateCode(cutoffIso) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(cutoffIso));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

/**
 * 夹具：批次 1（默认 24 小时后截单）、规格 1 公4两 1000 分 / 规格 2 母3两 2000 分、
 * 礼盒模板 1（规格1×5 + 规格2×5 = 10 只/份）、包装价 plain=0 / gift=1000 分、
 * 用户 1（codeusera）、用户 2（codeuserb）。
 */
async function makeApp({ cutoffTime } = {}) {
  const db = createDb(':memory:');
  const now = new Date().toISOString();
  const cutoff = cutoffTime ?? new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('packaging.plain', '0')");
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('packaging.gift', '1000')");
  db.run(
    "INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (1, 'batch-1', ?, 'open', ?)",
    cutoff, now,
  );
  db.run(
    "INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (1, 1, 'male', '4两', 1000, 1, 1)",
  );
  db.run(
    "INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (2, 1, 'female', '3两', 2000, 1, 2)",
  );
  db.run(
    "INSERT INTO package_templates (id, name, packaging, active, created_at) VALUES (1, '测试礼盒', 'gift', 1, ?)",
    now,
  );
  db.run('INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (1, 1, 5)');
  db.run('INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (1, 2, 5)');
  db.run(
    "INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (1, 'codeusera', '用户A', 'active', ?)",
    now,
  );
  db.run(
    "INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (2, 'codeuserb', '用户B', 'active', ?)",
    now,
  );

  const app = await buildApp({ db });
  return { app, db, cutoff };
}

function customShipment(qty, overrides = {}) {
  return {
    recipient: '张三',
    phone: '13800000000',
    address: '上海市徐汇区测试路 1 号',
    packaging: 'plain',
    items: [{ specId: 1, qty }],
    ...overrides,
  };
}

function postOrder(app, body, headers = USER_A) {
  return app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: body });
}

test('① 同一 idempotencyKey 重复提交只产一单，第二次返回 200 和相同订单号', async () => {
  const { app, db } = await makeApp();
  const body = { idempotencyKey: 'key-dup-1', shipments: [customShipment(10)] };

  const first = await postOrder(app, body);
  assert.equal(first.statusCode, 201);
  const second = await postOrder(app, body);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().order.orderNo, first.json().order.orderNo);
  assert.equal(second.json().order.id, first.json().order.id);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM orders').c, 1);

  await app.close();
});

test('幂等键跨用户复用时拒绝返回或挂接他人的订单', async () => {
  const { app, db } = await makeApp();
  const body = { idempotencyKey: 'key-cross-user', shipments: [customShipment(10)] };
  const first = await postOrder(app, body, USER_A);
  assert.equal(first.statusCode, 201);

  const second = await postOrder(app, body, USER_B);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(db.get('SELECT COUNT(*) AS c FROM orders').c, 1);

  await app.close();
});

test('② 同批次连续两单 seq=1,2，订单号格式 D<YYMMDD>-NNNN', async () => {
  const { app, cutoff } = await makeApp();
  const dateCode = expectedDateCode(cutoff);

  const r1 = await postOrder(app, { idempotencyKey: 'key-seq-1', shipments: [customShipment(10)] });
  const r2 = await postOrder(app, { idempotencyKey: 'key-seq-2', shipments: [customShipment(10)] });
  assert.equal(r1.statusCode, 201);
  assert.equal(r2.statusCode, 201);
  assert.equal(r1.json().order.seq, 1);
  assert.equal(r2.json().order.seq, 2);
  assert.equal(r1.json().order.orderNo, `D${dateCode}-0001`);
  assert.equal(r2.json().order.orderNo, `D${dateCode}-0002`);
  assert.match(r1.json().order.orderNo, /^D\d{6}-\d{4}$/);

  await app.close();
});

test('③ 套餐模板 3 份礼盒：包装费 3000 分，盒数=份数=3，蟹款按份数累加', async () => {
  const { app } = await makeApp();
  const res = await postOrder(app, {
    idempotencyKey: 'key-gift-3',
    shipments: [{
      recipient: '李四',
      phone: '13900000000',
      address: '北京市朝阳区测试路 2 号',
      templateId: 1,
      copies: 3,
    }],
  });
  assert.equal(res.statusCode, 201);
  const { order, shipments } = res.json();
  assert.equal(shipments.length, 1);
  const s = shipments[0];
  assert.equal(s.packaging, 'gift'); // 包装取自模板
  assert.equal(s.copies, 3);
  assert.equal(s.boxes, 3);
  // 每份蟹款 = 5×1000 + 5×2000 = 15000；3 份 = 45000
  assert.equal(s.amount.crabCents, 45000);
  assert.equal(s.amount.packagingCents, 3000);
  assert.equal(s.amount.totalCents, 48000);
  assert.equal(order.amount.packagingCents, 3000);
  assert.equal(order.amount.totalCents, 48000);

  await app.close();
});

test('④ 自定义模式盒数口径：8 只=1 盒，15 只=2 盒', async () => {
  const { app } = await makeApp();

  const r8 = await postOrder(app, {
    idempotencyKey: 'key-box-8',
    confirmBelowTen: true,
    shipments: [customShipment(8)],
  });
  assert.equal(r8.statusCode, 201);
  assert.equal(r8.json().shipments[0].boxes, 1);
  assert.equal(r8.json().shipments[0].amount.crabCents, 8000);

  const r15 = await postOrder(app, { idempotencyKey: 'key-box-15', shipments: [customShipment(15)] });
  assert.equal(r15.statusCode, 201);
  assert.equal(r15.json().shipments[0].boxes, 2);
  assert.equal(r15.json().shipments[0].amount.crabCents, 15000);

  await app.close();
});

test('⑤ 低于 10 只未确认 → 422 BELOW_TEN_NEEDS_CONFIRM，带 confirmBelowTen → 201', async () => {
  const { app, db } = await makeApp();

  const denied = await postOrder(app, { idempotencyKey: 'key-below-10', shipments: [customShipment(8)] });
  assert.equal(denied.statusCode, 422);
  assert.equal(denied.json().error.code, 'BELOW_TEN_NEEDS_CONFIRM');
  assert.equal(db.get('SELECT COUNT(*) AS c FROM orders').c, 0);

  const confirmed = await postOrder(app, {
    idempotencyKey: 'key-below-10',
    confirmBelowTen: true,
    shipments: [customShipment(8)],
  });
  assert.equal(confirmed.statusCode, 201);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM orders').c, 1);

  await app.close();
});

test('⑥ 截单后提交自动进入下一批次', async () => {
  const { app } = await makeApp({ cutoffTime: new Date(Date.now() - 3600 * 1000).toISOString() });
  const res = await postOrder(app, { idempotencyKey: 'key-cutoff', shipments: [customShipment(10)] });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().order.batchId, 2);
  await app.close();
});

test('⑦ 多地址拆成多个 shipments，订单总额=各发货单之和', async () => {
  const { app } = await makeApp();
  const res = await postOrder(app, {
    idempotencyKey: 'key-multi-addr',
    shipments: [
      customShipment(10), // 10000 分
      customShipment(12, { recipient: '王五', address: '广州市天河区测试路 3 号' }), // 12000 分
    ],
  });
  assert.equal(res.statusCode, 201);
  const { order, shipments } = res.json();
  assert.equal(shipments.length, 2);
  assert.deepEqual(shipments.map((s) => s.seq), [1, 2]);
  assert.equal(shipments[0].amount.totalCents, 10000);
  assert.equal(shipments[1].amount.totalCents, 12000);
  assert.equal(order.amount.crabCents, 22000);
  assert.equal(order.amount.totalCents, 22000);
  assert.equal(shipments[0].amount.freightCents, null); // 运费待确认

  await app.close();
});

test('⑧ 越权读别人订单 → 403 ORDER_FORBIDDEN；列表只看得到自己的', async () => {
  const { app } = await makeApp();
  const created = await postOrder(app, { idempotencyKey: 'key-owner', shipments: [customShipment(10)] });
  assert.equal(created.statusCode, 201);
  const orderId = created.json().order.id;

  const detail = await app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: USER_B });
  assert.equal(detail.statusCode, 403);
  assert.equal(detail.json().error.code, 'ORDER_FORBIDDEN');

  const repurchase = await app.inject({
    method: 'GET',
    url: `/api/v1/orders/${orderId}/repurchase-config`,
    headers: USER_B,
  });
  assert.equal(repurchase.statusCode, 403);

  const listB = await app.inject({ method: 'GET', url: '/api/v1/orders', headers: USER_B });
  assert.equal(listB.statusCode, 200);
  assert.equal(listB.json().orders.length, 0);

  const listA = await app.inject({ method: 'GET', url: '/api/v1/orders', headers: USER_A });
  assert.equal(listA.json().orders.length, 1);
  assert.equal(listA.json().orders[0].orderNo, created.json().order.orderNo);
  assert.equal(listA.json().orders[0].status, 'submitted');

  // 本人可读详情，含金额构成和 config_snapshot
  const own = await app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: USER_A });
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().order.configSnapshot.boxCapacity, 10);
  assert.equal(own.json().order.configSnapshot.packagingPrices.gift, 1000);
  assert.equal(own.json().shipments[0].amount.freightCents, null);

  // 同配置再下单：不含地址、不含旧运费
  const re = await app.inject({
    method: 'GET',
    url: `/api/v1/orders/${orderId}/repurchase-config`,
    headers: USER_A,
  });
  assert.equal(re.statusCode, 200);
  assert.deepEqual(re.json(), {
    shipments: [{ packaging: 'plain', copies: null, items: [{ specId: 1, qty: 10 }] }],
  });

  await app.close();
});

test('⑨ 购物车草稿增删改查，且用户之间互相隔离', async () => {
  const { app } = await makeApp();

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/cart/drafts',
    headers: USER_A,
    payload: { payload: { items: [{ specId: 1, qty: 10 }], note: '草稿一' } },
  });
  assert.equal(created.statusCode, 201);
  const draftId = created.json().draft.id;
  assert.equal(created.json().draft.payload.note, '草稿一');

  const updated = await app.inject({
    method: 'PUT',
    url: `/api/v1/cart/drafts/${draftId}`,
    headers: USER_A,
    payload: { payload: { items: [{ specId: 2, qty: 20 }], note: '草稿一改' } },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().draft.payload.note, '草稿一改');

  const list = await app.inject({ method: 'GET', url: '/api/v1/cart/drafts', headers: USER_A });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().drafts.length, 1);
  assert.equal(list.json().drafts[0].payload.note, '草稿一改');

  // 其他用户：不可见、不可改、不可删
  const listB = await app.inject({ method: 'GET', url: '/api/v1/cart/drafts', headers: USER_B });
  assert.equal(listB.json().drafts.length, 0);
  const putB = await app.inject({
    method: 'PUT',
    url: `/api/v1/cart/drafts/${draftId}`,
    headers: USER_B,
    payload: { payload: { note: '越权' } },
  });
  assert.equal(putB.statusCode, 404);
  const delB = await app.inject({ method: 'DELETE', url: `/api/v1/cart/drafts/${draftId}`, headers: USER_B });
  assert.equal(delB.statusCode, 404);

  const del = await app.inject({ method: 'DELETE', url: `/api/v1/cart/drafts/${draftId}`, headers: USER_A });
  assert.equal(del.statusCode, 204);
  const after = await app.inject({ method: 'GET', url: '/api/v1/cart/drafts', headers: USER_A });
  assert.equal(after.json().drafts.length, 0);

  await app.close();
});

test('⑩ 带 draftId 提交成功后，对应购物车草稿被删除', async () => {
  const { app } = await makeApp();

  const draft = await app.inject({
    method: 'POST',
    url: '/api/v1/cart/drafts',
    headers: USER_A,
    payload: { payload: { items: [{ specId: 1, qty: 10 }] } },
  });
  const draftId = draft.json().draft.id;

  const res = await postOrder(app, {
    idempotencyKey: 'key-with-draft',
    draftId,
    shipments: [customShipment(10)],
  });
  assert.equal(res.statusCode, 201);

  const list = await app.inject({ method: 'GET', url: '/api/v1/cart/drafts', headers: USER_A });
  assert.equal(list.json().drafts.length, 0);

  await app.close();
});
