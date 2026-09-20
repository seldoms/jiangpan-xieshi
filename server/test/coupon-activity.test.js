import './helpers/selling-season.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { createOrder } from '../src/repositories/orderRepo.js';
import { resolveCouponActivity, EMPTY_COUPON_ACTIVITY } from '../src/money.js';
import {
  countCouponUsage,
  getCouponActivityState,
  setCouponActivity,
} from '../src/repositories/configRepo.js';

// 本文件独占：coupon-activity.test.js
//
// 后台可配置的「满减优惠码」活动（取代旧的关键词券）。用户口径原文：
//   「可以配置满多少减多少，一共多少张；所有用户共用一个码，一共用多少次」
//   「取消订单、退款也算用掉了，不退回」「点击生效」「归 0 即结束优惠活动」
//
// 十条边界对应关系见每条用例标题前的编号（① ~ ⑩）。
//
// 夹具（照 orders.test.js / coupon.test.js 的风格）：
//   批次 1 open（24 小时后截单）
//   规格 1：公 4两  1000 分/只 → 10 只 = 10000 分蟹款（= 100 元）
//   规格 2：母 3两  2000 分/只
//   规格 3：公 2两  2900 分/只 → 10 只 = 29000 分蟹款（= 290 元）
//   规格 4：公 2两   900 分/只 → 10 只 =  9000 分蟹款（=  90 元，未达门槛用）
//   包装价 plain = 0 / gift = 2000 分（= 20 元/盒）
//   用户 1 codeusera、用户 2 codeuserb

const COUPON_CODE = '蟹满减2026';
const ADMIN = { authorization: 'Bearer dev-admin-token' };

async function makeApp() {
  const db = createDb(':memory:');
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('packaging.plain', '0')");
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('packaging.gift', '2000')");
  db.run(
    "INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (1, 'batch-1', ?, 'open', ?)",
    cutoff, now,
  );
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (1, 1, 'male', '4两', 1000, 1, 1)");
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (2, 1, 'female', '3两', 2000, 1, 2)");
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (3, 1, 'male', '2两', 2900, 1, 3)");
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (4, 1, 'male', '2两', 900, 1, 4)");
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (1, 'codeusera', '用户A', 'active', ?)", now);
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (2, 'codeuserb', '用户B', 'active', ?)", now);

  const app = await buildApp({ db });
  return { app, db };
}

const USER_A = { 'x-order-code': 'codeusera' };
const USER_B = { 'x-order-code': 'codeuserb' };

/** 默认 10 只规格 1（蟹款 10000 分），可覆盖任意字段。 */
function shipment(qty, overrides = {}) {
  return {
    recipient: '张三',
    phone: '13800000000',
    address: '上海市徐汇区测试路 1 号',
    packaging: 'plain',
    items: [{ specId: 1, qty }],
    ...overrides,
  };
}

/** 后台配置活动（默认：满 100 元减 10 元、共 5 张、已生效）。 */
function configure(db, overrides = {}) {
  return setCouponActivity(db, {
    code: COUPON_CODE,
    minCents: 10000,
    discountCents: 1000,
    total: 5,
    enabled: true,
    ...overrides,
  });
}

function postOrder(app, body, headers = USER_A) {
  return app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: body });
}

function putCoupon(app, payload) {
  return app.inject({ method: 'PUT', url: '/api/v1/admin/coupon', headers: ADMIN, payload });
}

function toggleCoupon(app, payload = {}) {
  return app.inject({ method: 'POST', url: '/api/v1/admin/coupon/toggle', headers: ADMIN, payload });
}

function orderCount(db) {
  return db.get('SELECT COUNT(*) AS c FROM orders').c;
}

/** 模拟「取消订单 / 退款」：本平台的取消就是软删 orders.deleted_at。 */
function softDeleteOrder(db, orderId) {
  db.run('UPDATE orders SET deleted_at = ? WHERE id = ?', new Date().toISOString(), orderId);
}

/* ------------------------------------------------------------------ *
 * ① 活动未启用 / 未配置 → 用户用不了码
 * ------------------------------------------------------------------ */

test('① 活动已配置但未点「生效」→ 用码被拒（400 COUPON_INACTIVE），且不落单', async () => {
  const { app, db } = await makeApp();
  configure(db, { enabled: false });
  assert.equal(getCouponActivityState(db).active, false);

  const res = await postOrder(app, {
    idempotencyKey: 'inactive-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10)],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'COUPON_INACTIVE');
  assert.match(res.json().error.message, /尚未生效|没有可用/);
  assert.equal(orderCount(db), 0, '被拒时不能留下订单');

  await app.close();
  db.close();
});

test('①b 后台还没配置过活动（settings 里没有 coupon.activity.*）→ 同样被拒', async () => {
  const { app, db } = await makeApp();
  const state = getCouponActivityState(db);
  assert.equal(state.configured, false);
  assert.equal(state.active, false);
  assert.equal(state.used, 0);
  assert.equal(state.remaining, 0);

  const res = await postOrder(app, {
    idempotencyKey: 'unconfigured-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10)],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'COUPON_INACTIVE');
  assert.equal(orderCount(db), 0);

  await app.close();
  db.close();
});

/* ------------------------------------------------------------------ *
 * ② 蟹款 < 门槛 → 拒绝
 * ------------------------------------------------------------------ */

test('② 蟹款未达门槛 → 422 COUPON_MIN_NOT_MET，且不落单', async () => {
  const { app, db } = await makeApp();
  configure(db, { minCents: 10000, discountCents: 1000, total: 5 });

  // 规格 4 × 10 只 = 9000 分蟹款 < 10000 分门槛（满 10 只，不撞「不足 10 只需确认」）
  const res = await postOrder(app, {
    idempotencyKey: 'min-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10, { items: [{ specId: 4, qty: 10 }] })],
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, 'COUPON_MIN_NOT_MET');
  assert.match(res.json().error.message, /100 元/);
  assert.equal(orderCount(db), 0);
  assert.equal(countCouponUsage(db, COUPON_CODE), 0, '被拒的订单不占名额');

  await app.close();
  db.close();
});

/* ------------------------------------------------------------------ *
 * ③ 蟹款 == 门槛 → 通过（含等号）
 * ------------------------------------------------------------------ */

test('③ 蟹款恰好等于门槛 → 通过（含等号），并按面额立减', async () => {
  const { app, db } = await makeApp();
  configure(db, { minCents: 10000, discountCents: 1000, total: 5 });

  const res = await postOrder(app, {
    idempotencyKey: 'eq-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10)],
  });
  assert.equal(res.statusCode, 201);
  const amount = res.json().order.amount;
  assert.equal(amount.crabCents, 10000, '蟹款恰好 10000 分 = 门槛');
  assert.equal(amount.couponCode, COUPON_CODE);
  assert.equal(amount.discountCents, 1000);
  assert.equal(amount.totalCents, 9000);

  // 落库自证（迁移 009 的两列）
  assert.deepEqual(
    db.get('SELECT coupon_code, discount_cents, total_cents FROM orders WHERE id = ?', res.json().order.id),
    { coupon_code: COUPON_CODE, discount_cents: 1000, total_cents: 9000 },
  );
  assert.equal(countCouponUsage(db, COUPON_CODE), 1);

  await app.close();
  db.close();
});

/* ------------------------------------------------------------------ *
 * ④ 门槛按蟹款算：不含包装费（也不含运费）
 * ------------------------------------------------------------------ */

test('④ 门槛不含包装费：蟹款 290 + 包装费 20 = 合计 310 ≥ 门槛 300，仍然被拒', async () => {
  const { app, db } = await makeApp();
  configure(db, { minCents: 30000, discountCents: 1000, total: 5 });

  const res = await postOrder(app, {
    idempotencyKey: 'pack-1',
    couponCode: COUPON_CODE,
    // 规格 3 × 10 只 = 29000 分（290 元）；gift 包装 1 盒 × 2000 分（20 元）
    shipments: [shipment(10, { items: [{ specId: 3, qty: 10 }], packaging: 'gift' })],
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, 'COUPON_MIN_NOT_MET');
  assert.match(res.json().error.message, /不含包装费/);
  assert.equal(orderCount(db), 0);

  // 同一笔交易，把门槛降到 290 元（= 纯蟹款）就立刻可用 → 证明判定口径就是蟹款
  configure(db, { minCents: 29000, discountCents: 1000, total: 5 });
  const ok = await postOrder(app, {
    idempotencyKey: 'pack-2',
    couponCode: COUPON_CODE,
    shipments: [shipment(10, { items: [{ specId: 3, qty: 10 }], packaging: 'gift' })],
  });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().order.amount.crabCents, 29000);
  assert.equal(ok.json().order.amount.packagingCents, 2000);
  assert.equal(ok.json().order.amount.totalCents, 30000, '29000 + 2000 - 1000');

  await app.close();
  db.close();
});

/* ------------------------------------------------------------------ *
 * ⑤ 共 N 张 = 总共能用 N 次，用满即止（第 N+1 次被拒）
 * ------------------------------------------------------------------ */

test('⑤ 用满 N 张后第 N+1 次被拒（409 COUPON_SOLD_OUT）；且一个码所有用户共用', async () => {
  const { app, db } = await makeApp();
  configure(db, { total: 2 });

  // 同一条活动码，两个**不同用户**都能用 —— 这就是「所有用户共用一个码」
  const first = await postOrder(app, {
    idempotencyKey: 'sold-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10, { phone: '13800000001' })],
  }, USER_A);
  assert.equal(first.statusCode, 201);

  const second = await postOrder(app, {
    idempotencyKey: 'sold-2',
    couponCode: COUPON_CODE,
    shipments: [shipment(10, { phone: '13800000002' })],
  }, USER_B);
  assert.equal(second.statusCode, 201);

  assert.equal(countCouponUsage(db, COUPON_CODE), 2);
  const state = getCouponActivityState(db);
  assert.equal(state.used, 2);
  assert.equal(state.remaining, 0);
  assert.equal(state.active, false, '归 0 即结束');
  assert.equal(state.ended, true);

  // 第 3 次（换用户、换手机号、新幂等键都一样）→ 用满即止
  const third = await postOrder(app, {
    idempotencyKey: 'sold-3',
    couponCode: COUPON_CODE,
    shipments: [shipment(10, { phone: '13800000003' })],
  }, USER_A);
  assert.equal(third.statusCode, 409);
  assert.equal(third.json().error.code, 'COUPON_SOLD_OUT');
  assert.equal(orderCount(db), 2, '第 3 单不能落库');

  // 不用券照常下单（券用完只挡券，不挡生意）
  const noCoupon = await postOrder(app, {
    idempotencyKey: 'sold-4',
    shipments: [shipment(10, { phone: '13800000004' })],
  }, USER_A);
  assert.equal(noCoupon.statusCode, 201);
  assert.equal(noCoupon.json().order.amount.discountCents, 0);
  assert.equal(countCouponUsage(db, COUPON_CODE), 2, '不用券的订单不占名额');

  await app.close();
  db.close();
});

/* ------------------------------------------------------------------ *
 * ⑥ 计数包含已取消 / 已退款（软删）的订单，不退回
 * ------------------------------------------------------------------ */

test('⑥ 已取消（软删）的订单照样占名额：软删一张后再下单仍被拒', async () => {
  const { app, db } = await makeApp();
  configure(db, { total: 2 });

  const first = await postOrder(app, {
    idempotencyKey: 'del-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10, { phone: '13800000001' })],
  });
  const second = await postOrder(app, {
    idempotencyKey: 'del-2',
    couponCode: COUPON_CODE,
    shipments: [shipment(10, { phone: '13800000002' })],
  });
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.equal(getCouponActivityState(db).remaining, 0);

  // 取消第一单（本平台的取消 = 软删 orders.deleted_at）—— 名额不退回
  softDeleteOrder(db, first.json().order.id);
  assert.notEqual(
    db.get('SELECT deleted_at FROM orders WHERE id = ?', first.json().order.id).deleted_at,
    null,
  );

  assert.equal(countCouponUsage(db, COUPON_CODE), 2, 'countCouponUsage 不过滤 deleted_at');
  const state = getCouponActivityState(db);
  assert.equal(state.used, 2);
  assert.equal(state.remaining, 0);
  assert.equal(state.active, false);
  assert.equal(state.ended, true);

  const third = await postOrder(app, {
    idempotencyKey: 'del-3',
    couponCode: COUPON_CODE,
    shipments: [shipment(10, { phone: '13800000003' })],
  });
  assert.equal(third.statusCode, 409, '取消不退名额，第 3 次仍被拒');
  assert.equal(third.json().error.code, 'COUPON_SOLD_OUT');
  assert.equal(orderCount(db), 2);

  await app.close();
  db.close();
});

/* ------------------------------------------------------------------ *
 * ⑦ 码错误 → 拒绝
 * ------------------------------------------------------------------ */

test('⑦ 活动码输错 → 400 COUPON_CODE_INVALID（不静默忽略）', async () => {
  const { app, db } = await makeApp();
  configure(db);

  const res = await postOrder(app, {
    idempotencyKey: 'wrong-1',
    couponCode: '蟹满减2025',
    shipments: [shipment(10)],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'COUPON_CODE_INVALID');
  assert.equal(orderCount(db), 0);
  assert.equal(countCouponUsage(db, COUPON_CODE), 0, '输错码不消耗名额');

  // 空券码 / 不传 = 不用券，不能报错
  const none = await postOrder(app, {
    idempotencyKey: 'wrong-2',
    couponCode: '',
    shipments: [shipment(10)],
  });
  assert.equal(none.statusCode, 201);
  assert.equal(none.json().order.amount.couponCode, null);
  assert.equal(none.json().order.amount.discountCents, 0);

  await app.close();
  db.close();
});

/* ------------------------------------------------------------------ *
 * ⑧ 减免后金额不为负
 * ------------------------------------------------------------------ */

test('⑧ 减免不超过蟹款：面额比蟹款还大时实付为 0，绝不为负', async () => {
  const { app, db } = await makeApp();
  // 门槛 0、面额 9999.99 元，远超 100 元的蟹款
  configure(db, { minCents: 0, discountCents: 999999, total: 5 });

  const res = await postOrder(app, {
    idempotencyKey: 'neg-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10)],
  });
  assert.equal(res.statusCode, 201);
  const amount = res.json().order.amount;
  assert.equal(amount.crabCents, 10000);
  assert.equal(amount.discountCents, 10000, '减免被夹到蟹款上限');
  assert.equal(amount.totalCents, 0);
  assert.ok(amount.totalCents >= 0);

  await app.close();
  db.close();
});

/* ------------------------------------------------------------------ *
 * ⑨ 不用券的订单金额与改动前完全一致（回归）
 * ------------------------------------------------------------------ */

test('⑨ 回归：不用券时金额与改动前完全一致（新字段只有 0 / null）', async () => {
  const { app, db } = await makeApp();
  configure(db);

  const res = await postOrder(app, {
    idempotencyKey: 'regress-1',
    shipments: [shipment(10), shipment(10, { phone: '13800000009', packaging: 'gift' })],
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json().order.amount, {
    crabCents: 20000,
    packagingCents: 2000,
    freightCents: null,
    totalCents: 22000,
    discountCents: 0,
    couponCode: null,
  });
  // 成本口径（蟹款 + 包装 + 已录运费）不受券字段影响
  assert.equal(res.json().order.amount.crabCents + res.json().order.amount.packagingCents, 22000);

  assert.deepEqual(
    db.get('SELECT discount_cents, coupon_code FROM orders WHERE id = ?', res.json().order.id),
    { discount_cents: 0, coupon_code: null },
  );

  // 发货单金额也一分没变
  const firstShipment = res.json().shipments[0].amount;
  assert.deepEqual(firstShipment, {
    crabCents: 10000, packagingCents: 0, freightCents: null, totalCents: 10000,
  });

  await app.close();
  db.close();
});

/* ------------------------------------------------------------------ *
 * ⑩ 后台改配置后立即生效
 * ------------------------------------------------------------------ */

test('⑩ 后台改配置（PUT /api/v1/admin/coupon）后立即生效，不用重启', async () => {
  const { app, db } = await makeApp();
  configure(db, { minCents: 50000, discountCents: 1000, total: 5 });

  // 门槛 500 元 → 100 元蟹款用不了
  const before = await postOrder(app, {
    idempotencyKey: 'live-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10)],
  });
  assert.equal(before.statusCode, 422);
  assert.equal(before.json().error.code, 'COUPON_MIN_NOT_MET');

  // 后台改成「满 100 减 25、共 3 张、生效」
  const saved = await putCoupon(app, {
    code: COUPON_CODE, minCents: 10000, discountCents: 2500, total: 3, enabled: true,
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().coupon, {
    code: COUPON_CODE, minCents: 10000, discountCents: 2500, total: 3, enabled: true,
    configured: true, used: 0, remaining: 3, active: true, ended: false,
  });

  // 同一个进程里下一单立刻按新配置算
  const after = await postOrder(app, {
    idempotencyKey: 'live-2',
    couponCode: COUPON_CODE,
    shipments: [shipment(10)],
  });
  assert.equal(after.statusCode, 201);
  assert.equal(after.json().order.amount.discountCents, 2500);
  assert.equal(after.json().order.amount.totalCents, 7500);
  assert.equal(getCouponActivityState(db).remaining, 2);

  // 再把「共 3 张」改成 1 张（已用 1 张）→ 立即用满、活动结束
  const shrunk = await putCoupon(app, {
    code: COUPON_CODE, minCents: 10000, discountCents: 2500, total: 1, enabled: true,
  });
  assert.equal(shrunk.json().coupon.remaining, 0);
  assert.equal(shrunk.json().coupon.active, false);
  assert.equal(shrunk.json().coupon.ended, true);

  const afterShrink = await postOrder(app, {
    idempotencyKey: 'live-3',
    couponCode: COUPON_CODE,
    shipments: [shipment(10)],
  });
  assert.equal(afterShrink.statusCode, 409);

  await app.close();
  db.close();
});

/* ------------------------------------------------------------------ *
 * 剩余张数口径 + 管理端「使用订单」列表
 * ------------------------------------------------------------------ */

test('剩余张数 = max(0, 总张数 - 已用张数)，已用张数含软删订单；未配置时为 0', async () => {
  const { app, db } = await makeApp();
  assert.equal(getCouponActivityState(db).remaining, 0, '未配置：剩余 0、不生效');

  configure(db, { total: 3 });
  let state = getCouponActivityState(db);
  assert.equal(state.used, 0);
  assert.equal(state.remaining, 3);
  assert.equal(state.active, true);

  const order = await postOrder(app, {
    idempotencyKey: 'remain-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10)],
  });
  assert.equal(getCouponActivityState(db).remaining, 2);

  softDeleteOrder(db, order.json().order.id);
  state = getCouponActivityState(db);
  assert.equal(state.used, 1, '取消/退款也算用掉了');
  assert.equal(state.remaining, 2, '不退回');

  // 后台把总量降到已用次数以下 → 剩余夹到 0（不允许负数），活动结束
  configure(db, { total: 0, code: COUPON_CODE });
  state = getCouponActivityState(db);
  assert.equal(state.remaining, 0);
  assert.equal(state.configured, false, '张数为 0 = 没配齐');
  assert.equal(state.active, false);

  await app.close();
  db.close();
});

test('管理端「使用订单」列表：订单号/下单人/蟹款/立减/时间/是否已取消，含取消单、且不含不用券的单', async () => {
  const { app, db } = await makeApp();
  configure(db, { total: 5 });

  const a = await postOrder(app, {
    idempotencyKey: 'list-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10, { phone: '13800000001' })],
  }, USER_A);
  const b = await postOrder(app, {
    idempotencyKey: 'list-2',
    couponCode: COUPON_CODE,
    shipments: [shipment(10, { phone: '13800000002' })],
  }, USER_B);
  const plain = await postOrder(app, {
    idempotencyKey: 'list-3',
    shipments: [shipment(10, { phone: '13800000003' })],
  }, USER_A);
  assert.equal(plain.statusCode, 201);
  softDeleteOrder(db, a.json().order.id);

  const res = await app.inject({ method: 'GET', url: '/api/v1/admin/coupon/orders', headers: ADMIN });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.coupon.code, COUPON_CODE);
  assert.equal(body.coupon.used, 2, '列表里的用券单数与「已用张数」同一口径');
  assert.equal(body.coupon.remaining, 3);

  assert.equal(body.orders.length, 2, '不用券的订单不进列表');
  const cancelled = body.orders.find((o) => o.orderNo === a.json().order.orderNo);
  const normal = body.orders.find((o) => o.orderNo === b.json().order.orderNo);
  assert.equal(cancelled.cancelled, true, '取消（软删）的用券单照实列出并标记');
  assert.ok(cancelled.cancelledAt);
  assert.equal(normal.cancelled, false);
  assert.equal(normal.cancelledAt, null);

  assert.equal(normal.userDisplayName, '用户B');
  assert.equal(normal.userOrderCode, 'codeuserb');
  assert.equal(normal.recipients, '张三 13800000002');
  assert.equal(normal.crabCents, 10000);
  assert.equal(normal.discountCents, 1000);
  assert.equal(normal.couponCode, COUPON_CODE);
  assert.ok(normal.createdAt, '下单时间');
  assert.equal(normal.source, 'personal');

  await app.close();
  db.close();
});

test('管理端优惠码接口需要管理员权限（401），未配置时不能「点生效」', async () => {
  const { app, db } = await makeApp();

  for (const call of [
    { method: 'GET', url: '/api/v1/admin/coupon' },
    { method: 'GET', url: '/api/v1/admin/coupon/orders' },
    { method: 'PUT', url: '/api/v1/admin/coupon', payload: { code: 'X', minCents: 0, discountCents: 1, total: 1 } },
    { method: 'POST', url: '/api/v1/admin/coupon/toggle', payload: {} },
  ]) {
    const res = await app.inject(call);
    assert.equal(res.statusCode, 401, `${call.method} ${call.url} 应 401`);
  }

  // 还没配活动就想点生效 → 明确报错（而不是「生效了但用户用不了」）
  const toggle = await toggleCoupon(app, { enabled: true });
  assert.equal(toggle.statusCode, 422);
  assert.equal(toggle.json().error.code, 'COUPON_NOT_CONFIGURED');

  await app.close();
  db.close();
});

test('「点击生效 / 停用」只切开关，不动已配好的门槛、面额、张数', async () => {
  const { app, db } = await makeApp();
  configure(db, { enabled: false });

  const on = await toggleCoupon(app);
  assert.equal(on.statusCode, 200);
  assert.equal(on.json().coupon.enabled, true);
  assert.equal(on.json().coupon.active, true);
  assert.deepEqual(
    [on.json().coupon.code, on.json().coupon.minCents, on.json().coupon.discountCents, on.json().coupon.total],
    [COUPON_CODE, 10000, 1000, 5],
    '门槛/面额/张数原样保留',
  );

  const off = await toggleCoupon(app, { enabled: false });
  assert.equal(off.json().coupon.enabled, false);
  assert.equal(off.json().coupon.active, false);

  await app.close();
  db.close();
});

test('后台配置校验：活动码格式、总张数、减免金额非法一律 422；活动码留空 = 撤下活动', async () => {
  const { app, db } = await makeApp();

  const badCode = await putCoupon(app, { code: '满 300 减 10', minCents: 30000, discountCents: 1000, total: 5 });
  assert.equal(badCode.statusCode, 422);
  assert.equal(badCode.json().error.code, 'COUPON_CODE_INVALID');

  const noTotal = await putCoupon(app, { code: COUPON_CODE, minCents: 30000, discountCents: 1000, total: 0 });
  assert.equal(noTotal.statusCode, 422);
  assert.equal(noTotal.json().error.code, 'COUPON_TOTAL_INVALID');

  const noDiscount = await putCoupon(app, { code: COUPON_CODE, minCents: 30000, discountCents: 0, total: 5 });
  assert.equal(noDiscount.statusCode, 422);
  assert.equal(noDiscount.json().error.code, 'COUPON_DISCOUNT_INVALID');

  const badMin = await putCoupon(app, { code: COUPON_CODE, minCents: -1, discountCents: 1000, total: 5 });
  assert.equal(badMin.statusCode, 422);

  const badEnabled = await putCoupon(app, { code: COUPON_CODE, minCents: 0, discountCents: 1000, total: 5, enabled: 'yes' });
  assert.equal(badEnabled.statusCode, 422);

  // 合法配置：满 300 减 10、共 8888 张（用户举的例子）
  const ok = await putCoupon(app, { code: COUPON_CODE, minCents: 30000, discountCents: 1000, total: 8888, enabled: true });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().coupon.total, 8888);

  // 活动码留空 = 撤下活动；门槛/面额/张数原样保留
  const withdrawn = await putCoupon(app, { code: '', minCents: 30000, discountCents: 1000, total: 8888, enabled: false });
  assert.equal(withdrawn.statusCode, 200);
  assert.equal(withdrawn.json().coupon.code, '');
  assert.equal(withdrawn.json().coupon.configured, false);
  assert.equal(withdrawn.json().coupon.total, 8888);

  // 撤下之后，用户端再用原来的码 → 拒绝
  const useAfter = await postOrder(app, {
    idempotencyKey: 'withdrawn-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10)],
  });
  assert.equal(useAfter.statusCode, 400);
  assert.equal(useAfter.json().error.code, 'COUPON_INACTIVE');
  assert.equal(orderCount(db), 0);

  await app.close();
  db.close();
});

test('拼团单不参与满减活动：传了券码被拒、不传照旧', async () => {
  const { app, db } = await makeApp();
  configure(db);

  const rejected = () => createOrder(db, {
    batchId: 1,
    userId: 1,
    source: 'group',
    idempotencyKey: 'group-1',
    couponCode: COUPON_CODE,
    shipments: [shipment(10)],
  });
  assert.throws(rejected, (err) => err.code === 'COUPON_NOT_FOR_GROUP');
  assert.equal(orderCount(db), 0);

  const created = createOrder(db, {
    batchId: 1,
    userId: 1,
    source: 'group',
    idempotencyKey: 'group-2',
    shipments: [shipment(10)],
  });
  assert.equal(created.order.coupon_code, null);
  assert.equal(created.order.discount_cents, 0);
  assert.equal(countCouponUsage(db, COUPON_CODE), 0);

  await app.close();
  db.close();
});

test('用户端 config/current 下发活动状态（一个码共用，前端只做预览、算钱以后端为准）', async () => {
  const { app, db } = await makeApp();
  configure(db, { minCents: 30000, discountCents: 1000, total: 8888 });

  const res = await app.inject({ method: 'GET', url: '/api/v1/config/current' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().coupon, {
    code: COUPON_CODE,
    minCents: 30000,
    discountCents: 1000,
    total: 8888,
    enabled: true,
    configured: true,
    used: 0,
    remaining: 8888,
    active: true,
    ended: false,
  });

  await app.close();
  db.close();
});

test('纯函数 resolveCouponActivity：空码 = 不用券；判定顺序与错误码是契约', () => {
  const activity = { code: '满减码', minCents: 30000, discountCents: 1000, total: 2, enabled: true };
  const cases = [
    [null, '空码 → null'],
    ['', '空串 → null'],
    ['   ', '空白 → null'],
  ];
  for (const [code, label] of cases) {
    assert.equal(resolveCouponActivity({ activity, code, crabCents: 50000 }), null, label);
  }

  assert.deepEqual(
    resolveCouponActivity({ activity, code: '满减码', crabCents: 30000, usedCount: 0 }),
    { couponCode: '满减码', discountCents: 1000 },
    '蟹款恰好等于门槛 → 可用',
  );
  assert.deepEqual(
    resolveCouponActivity({
      activity: { code: '满减码', minCents: 0, discountCents: 999999, total: 2, enabled: true },
      code: '满减码',
      crabCents: 30000,
      usedCount: 0,
    }),
    { couponCode: '满减码', discountCents: 30000 },
    '减免夹到蟹款上限，不会为负',
  );

  const thrown = (input) => {
    try { resolveCouponActivity(input); return null; } catch (err) { return err; }
  };
  assert.equal(thrown({ activity: EMPTY_COUPON_ACTIVITY, code: '满减码', crabCents: 50000 }).code, 'COUPON_INACTIVE');
  assert.equal(thrown({ activity, code: '别的码', crabCents: 50000 }).code, 'COUPON_CODE_INVALID');
  assert.equal(thrown({ activity, code: '满减码', crabCents: 50000, usedCount: 2 }).code, 'COUPON_SOLD_OUT');
  assert.equal(thrown({ activity, code: '满减码', crabCents: 29999 }).code, 'COUPON_MIN_NOT_MET');
  // 用满优先于门槛（顺序即契约）
  assert.equal(thrown({ activity, code: '满减码', crabCents: 1, usedCount: 2 }).code, 'COUPON_SOLD_OUT');
});
