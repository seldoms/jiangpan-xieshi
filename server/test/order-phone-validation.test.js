import './helpers/selling-season.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createOrder } from '../src/repositories/orderRepo.js';

/**
 * 收货手机号格式校验：必须是 11 位数字、1 开头、第二位 3-9（/^1[3-9]\d{9}$/）。
 * 校验前先剔除空白与短横线，落库存清洗后的纯数字。
 * 本用例直接调用仓储层导出函数 createOrder，不重复实现校验逻辑。
 */

/** 内存库夹具：批次 1（24 小时后截单）、规格 1（1000 分）、用户 1。 */
function makeDb() {
  const db = createDb(':memory:');
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

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
    "INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (1, 'codeusera', '用户A', 'active', ?)",
    now,
  );
  return db;
}

function shipment(phone, overrides = {}) {
  return {
    recipient: '张三',
    phone,
    address: '上海市徐汇区测试路 1 号',
    packaging: 'plain',
    items: [{ specId: 1, qty: 10 }],
    ...overrides,
  };
}

/** 每个用例用独立内存库，避免幂等键/订单互相干扰。 */
let seq = 0;
function placeOrder(db, phone, overrides) {
  return createOrder(db, {
    batchId: 1,
    userId: 1,
    source: 'personal',
    idempotencyKey: `phone-key-${seq++}`,
    shipments: [shipment(phone, overrides)],
  });
}

function assertPhoneRejected(db, phone) {
  assert.throws(
    () => placeOrder(db, phone),
    (err) => {
      assert.equal(err.code, 'PHONE_INVALID');
      assert.match(err.message, /手机号格式不正确/);
      return true;
    },
    `期望 ${JSON.stringify(phone)} 被拒绝`,
  );
  assert.equal(db.get('SELECT COUNT(*) AS c FROM orders').c, 0, '被拒时不应写入订单');
}

test('合法手机号通过，并按原值落库', () => {
  const db = makeDb();
  const { order, shipments } = placeOrder(db, '13800000000');
  assert.ok(order.id > 0);
  assert.equal(shipments[0].phone, '13800000000');
  assert.equal(db.get('SELECT phone FROM shipments WHERE order_id = ?', order.id).phone, '13800000000');
  db.close();
});

test('10 位手机号被拒绝', () => {
  const db = makeDb();
  assertPhoneRejected(db, '1380000000');
  db.close();
});

test('12 位手机号被拒绝', () => {
  const db = makeDb();
  assertPhoneRejected(db, '138000000000');
  db.close();
});

test('9 位手机号被拒绝', () => {
  const db = makeDb();
  assertPhoneRejected(db, '138000000');
  db.close();
});

test('第二位为 2 的 11 位号码（12900001234）被拒绝', () => {
  const db = makeDb();
  assertPhoneRejected(db, '12900001234');
  db.close();
});

test('带空格/短横线的号码清洗后通过，落库为纯数字', () => {
  const spaced = makeDb();
  const r1 = placeOrder(spaced, '138 0000 0000');
  assert.equal(r1.shipments[0].phone, '13800000000');
  assert.equal(
    spaced.get('SELECT phone FROM shipments WHERE order_id = ?', r1.order.id).phone,
    '13800000000',
  );
  spaced.close();

  const dashed = makeDb();
  const r2 = placeOrder(dashed, '138-0000-0000');
  assert.equal(r2.shipments[0].phone, '13800000000');
  assert.equal(
    dashed.get('SELECT phone FROM shipments WHERE order_id = ?', r2.order.id).phone,
    '13800000000',
  );
  dashed.close();
});

test('空手机号仍被拒绝（SHIPMENT_INVALID）', () => {
  const db = makeDb();
  for (const empty of ['', '   ', null, undefined]) {
    assert.throws(
      () => placeOrder(db, empty),
      (err) => {
        assert.equal(err.code, 'SHIPMENT_INVALID');
        assert.match(err.message, /需要收货人、手机号和地址/);
        return true;
      },
      `期望空值 ${JSON.stringify(empty)} 被拒绝`,
    );
  }
  assert.equal(db.get('SELECT COUNT(*) AS c FROM orders').c, 0);
  db.close();
});
