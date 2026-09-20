import './helpers/selling-season.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { allocateFreight, allocatePackagingAndFreight } from '../src/money.js';

/**
 * 费用均摊专项：运费 + 包装费合并成一份总额一次性分完；除不尽的余数直接抹零（平台承担）。
 *
 * 口径（改动后）：
 * ① 每个成员分摊 <= 精确值（无人多付）；
 * ② Σ 分摊 <= 总额（不补齐到总额）；
 * ③ 差额 < 成员数（只丢分位）；
 * ④ 接口返回的 packagingShareCents + freightShareCents === 该成员分摊到的那一份；
 * ⑤ 未结单 / 运费未录入时只分摊包装费，不凭空造运费。
 */

const LEADER = { 'x-order-code': '团长a1b2' };

/**
 * 内存库夹具：开放批次 + 公4两(8800/200g) 与 母3两(7800/150g) 两个规格 + 包装价 1000 分/盒。
 */
async function makeApp(t, { createOrder = null } = {}) {
  const db = createDb(':memory:');
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() + 2 * 3600e3).toISOString();
  db.run(
    "INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (1, 't-batch', ?, 'open', ?)",
    cutoff, now,
  );
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (1, 1, 'male', '4两', 8800, 1, 1)");
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (2, 1, 'female', '3两', 7800, 1, 2)");
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (1, '团长a1b2', '团长', 'active', ?)", now);
  db.run("INSERT INTO settings (key, value) VALUES ('packaging.plain', '1000')");
  db.run("INSERT INTO settings (key, value) VALUES ('packaging.gift', '1000')");

  const app = await buildApp({ db });
  if (createOrder) app.decorate('createOrder', createOrder); // 必须在首次 inject 前注入
  t.after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

/** 结单用的订单替身：金额口径由用例指定（包装费 + 运费是均摊的输入）。 */
function stubOrder({ crabCents, packagingCents, freightCents }) {
  return (dbArg, input) => {
    const info = dbArg.run(
      `INSERT INTO orders
       (batch_id, seq, order_no, user_id, source, status, crab_cents, packaging_cents, freight_cents, config_snapshot, idempotency_key, created_at)
       VALUES (?, 1, ?, ?, 'group', 'submitted', ?, ?, ?, '{}', ?, ?)`,
      input.batchId,
      'D260919-0003',
      input.userId,
      crabCents,
      packagingCents,
      freightCents,
      input.idempotencyKey,
      new Date().toISOString(),
    );
    return { order: dbArg.get('SELECT * FROM orders WHERE id = ?', info.lastInsertRowid), shipments: [] };
  };
}

async function createGroup(app) {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/groups', headers: LEADER, payload: { title: '均摊测试团' },
  });
  assert.equal(res.statusCode, 200);
  return res.json().token;
}

async function addMember(app, token, payload) {
  const res = await app.inject({ method: 'POST', url: `/api/v1/groups/${token}/members`, payload });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().member;
}

async function submitGroup(app, token) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/groups/${token}/submit`,
    headers: LEADER,
    payload: { recipient: '团长', phone: '13800000000', address: '上海市测试路1号' },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

const readAmount = async (app, token) => {
  const res = await app.inject({ method: 'GET', url: `/api/v1/groups/${token}/amount` });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};

/** 通用不变式：不上溢、差额只丢分位、逐项 <= 精确值。 */
function assertNoOverpay(shares, exacts) {
  for (const [i, share] of shares.entries()) {
    assert.ok(Number.isInteger(share) && share >= 0, `share[${i}] 必须是非负整数`);
    assert.ok(share <= exacts[i], `share[${i}]=${share} 超过精确值 ${exacts[i]}（多付了）`);
  }
  const total = shares.reduce((a, b) => a + b, 0);
  assert.ok(total <= exacts.reduce((a, b) => a + b, 0), '分摊之和不得超过总额');
  return total;
}

test('合并均摊：包装费 + 运费一次分完，两项之和 = 该成员份额，抹零差额平台承担', async (t) => {
  const crabCents = 6 * 8800 + 4 * 7800;
  const { app } = await makeApp(t, {
    createOrder: stubOrder({ crabCents, packagingCents: 1000, freightCents: 999 }),
  });
  const token = await createGroup(app);
  await addMember(app, token, { name: '张三', specId: 1, quantity: 6 }); // 6 × 200g = 1200g
  await addMember(app, token, { name: '李四', specId: 2, quantity: 4 }); // 4 × 150g = 600g
  await submitGroup(app, token);

  const amount = await readAmount(app, token);
  assert.equal(amount.phase, 'final');
  assert.equal(amount.packagingCents, 1000);
  assert.equal(amount.freightCents, 999);
  assert.equal(amount.totalCents, crabCents + 1000 + 999); // 85999

  const [first, second] = amount.members;
  // 权重 1200 : 600 = 2 : 1；合并总额 1999 一次 floor
  assert.equal(first.packagingShareCents, 666); // floor(1000 × 2/3)
  assert.equal(first.freightShareCents, 666); // 1332 - 666
  assert.equal(first.totalCents, first.crabCents + 1332);
  assert.equal(second.packagingShareCents, 333); // floor(1000 × 1/3)
  assert.equal(second.freightShareCents, 333); // 666 - 333
  assert.equal(second.totalCents, second.crabCents + 666);

  // ④ 两项之和 = 该成员实际分摊到的那一份
  for (const m of amount.members) {
    assert.equal(m.packagingShareCents + m.freightShareCents, m.totalCents - m.crabCents);
  }
  assert.deepEqual(amount.members.map((m) => m.totalCents - m.crabCents), [1332, 666]);
  // 合并份额同样不超过精确值（无人多付）
  assertNoOverpay(
    amount.members.map((m) => m.totalCents - m.crabCents),
    [(1999 * 1200) / 1800, (1999 * 600) / 1800],
  );
  assertNoOverpay(
    amount.members.map((m) => m.packagingShareCents),
    [(1000 * 1200) / 1800, (1000 * 600) / 1800],
  );

  // ① 抹零后差额正确：成员合计比订单总额少 1 分（分位零头，平台承担，不补给任何人）
  const memberSum = amount.members.reduce((sum, m) => sum + m.totalCents, 0);
  assert.equal(memberSum, 85998);
  assert.equal(amount.totalCents - memberSum, 1);
  assert.ok(amount.totalCents - memberSum < amount.members.length);
  // Σ 运费行 <= 已录总运费，且不再由某位成员补齐
  assert.ok(
    amount.members.reduce((sum, m) => sum + m.freightShareCents, 0) <= amount.freightCents,
  );
});

test('合并均摊：未录运费时只分摊包装费，运费行保持 null（不凭空造运费）', async (t) => {
  const crabCents = 6 * 8800 + 4 * 7800;
  const { app } = await makeApp(t, {
    createOrder: stubOrder({ crabCents, packagingCents: 1000, freightCents: null }),
  });
  const token = await createGroup(app);
  await addMember(app, token, { name: '张三', specId: 1, quantity: 6 });
  await addMember(app, token, { name: '李四', specId: 2, quantity: 4 });
  await submitGroup(app, token);

  const amount = await readAmount(app, token);
  assert.equal(amount.phase, 'final');
  assert.equal(amount.freightCents, null);
  assert.deepEqual(amount.members.map((m) => m.freightShareCents), [null, null]);
  // 包装费按重量分摊：1000 × 2/3、1000 × 1/3，抹零 1 分
  assert.deepEqual(amount.members.map((m) => m.packagingShareCents), [666, 333]);
  for (const m of amount.members) {
    assert.equal(m.totalCents, m.crabCents + m.packagingShareCents);
  }
  const memberSum = amount.members.reduce((sum, m) => sum + m.totalCents, 0);
  assert.equal(amount.totalCents - memberSum, 1); // 包装费抹零 1 分
  assert.ok(amount.totalCents - memberSum < amount.members.length);
});

test('合并均摊：未结单估算阶段只分摊包装费，结单前后口径一致', async (t) => {
  const { app } = await makeApp(t);
  const token = await createGroup(app);
  await addMember(app, token, { name: '张三', specId: 1, quantity: 6 });
  await addMember(app, token, { name: '李四', specId: 2, quantity: 4 });

  const estimate = await readAmount(app, token);
  assert.equal(estimate.phase, 'estimate');
  assert.equal(estimate.freightCents, null);
  assert.deepEqual(estimate.members.map((m) => m.freightShareCents), [null, null]);
  assert.deepEqual(estimate.members.map((m) => m.packagingShareCents), [666, 333]);
  const estSum = estimate.members.reduce((sum, m) => sum + m.totalCents, 0);
  assert.ok(estSum <= estimate.totalCents);
  assert.ok(estimate.totalCents - estSum < estimate.members.length);
});

test('合并均摊：单个成员时不抹零，包装费与运费全额归该成员', async (t) => {
  const crabCents = 10 * 8800;
  const { app } = await makeApp(t, {
    createOrder: stubOrder({ crabCents, packagingCents: 1000, freightCents: 999 }),
  });
  const token = await createGroup(app);
  await addMember(app, token, { name: '独苗', specId: 1, quantity: 10 }); // 10 × 200g
  await submitGroup(app, token);

  const amount = await readAmount(app, token);
  assert.equal(amount.members.length, 1);
  const [only] = amount.members;
  assert.equal(only.packagingShareCents, 1000);
  assert.equal(only.freightShareCents, 999);
  assert.equal(only.totalCents, only.crabCents + 1999);
  assert.equal(only.totalCents, amount.totalCents); // 无零头可抹
});

test('合并均摊：成员规格无法识别重量时退回按只数分摊，接口不报错且不上溢', async (t) => {
  const crabCents = 6 * 8800 + 4 * 1000;
  const { app, db } = await makeApp(t, {
    createOrder: stubOrder({ crabCents, packagingCents: 1000, freightCents: 999 }),
  });
  // 脏规格：weightLabel 识别不出重量（历史数据里出现过「大号」这种写法）
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (3, 1, 'male', '大号', 1000, 1, 3)");
  const token = await createGroup(app);
  await addMember(app, token, { name: '张三', specId: 1, quantity: 6 }); // 6 × 200g = 1200g
  await addMember(app, token, { name: '李四', specId: 3, quantity: 4 }); // 重量不可识别
  await submitGroup(app, token);

  const amount = await readAmount(app, token);
  assert.equal(amount.phase, 'final');
  // 退回按只数 6 : 4 分摊：合并 1999 → 1199 / 799，包装 1000 → 600 / 400
  assert.deepEqual(
    amount.members.map((m) => m.totalCents - m.crabCents),
    [1199, 799],
  );
  assert.deepEqual(amount.members.map((m) => m.packagingShareCents), [600, 400]);
  for (const m of amount.members) {
    assert.equal(m.packagingShareCents + m.freightShareCents, m.totalCents - m.crabCents);
  }
  const memberSum = amount.members.reduce((sum, m) => sum + m.totalCents, 0);
  assert.equal(amount.totalCents - memberSum, 1);
  assert.ok(amount.totalCents - memberSum < amount.members.length);
});

test('权重边界：全 0 权重按份数均分并抹零，不产生负数', () => {
  assert.deepEqual(allocateFreight(10, [0, 0, 0]), [3, 3, 3]);
  assert.deepEqual(allocateFreight(0, [0, 0]), [0, 0]);
  assert.deepEqual(allocateFreight(2, [0, 0, 0, 0]), [0, 0, 0, 0]);
  const lines = allocatePackagingAndFreight({
    packagingCents: 0, freightCents: 0, weights: [0, 0, 0],
  });
  assert.deepEqual(lines.map((l) => l.freightShareCents), [0, 0, 0]);
  assert.ok(lines.every((l) => l.totalShareCents >= 0));
});

test('抹零：随机权重下差额永远小于成员数，且任何人都不会多付', () => {
  let seed = 2026;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let round = 0; round < 300; round++) {
    const n = 1 + Math.floor(rand() * 6);
    const weights = Array.from({ length: n }, () => Math.floor(rand() * 9000));
    const packagingCents = Math.floor(rand() * 50000);
    const freightCents = Math.floor(rand() * 50000);
    const lines = allocatePackagingAndFreight({ packagingCents, freightCents, weights });
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const exact = (cents, w) => (totalWeight === 0 ? cents / n : (cents * w) / totalWeight);
    const shareSum = lines.reduce((sum, l) => sum + l.totalShareCents, 0);
    const pkgSum = lines.reduce((sum, l) => sum + l.packagingShareCents, 0);
    assert.ok(shareSum <= packagingCents + freightCents);
    assert.ok(packagingCents + freightCents - shareSum < n);
    assert.ok(pkgSum <= packagingCents);
    assert.ok(packagingCents - pkgSum < n);
    lines.forEach((line, i) => {
      assert.equal(
        line.packagingShareCents + line.freightShareCents,
        line.totalShareCents,
        '两项之和必须等于该成员份额',
      );
      assert.ok(line.totalShareCents <= exact(packagingCents + freightCents, weights[i]));
      assert.ok(line.packagingShareCents <= exact(packagingCents, weights[i]));
      assert.ok(line.freightShareCents >= 0);
    });
  }
});


test('人工改价：超出「运费 + 包装费」总额被拒（400），额度内的改价仍可落库', async (t) => {
  const crabCents = 6 * 8800 + 4 * 7800;
  const { app, db } = await makeApp(t, {
    createOrder: stubOrder({ crabCents, packagingCents: 1000, freightCents: 999 }),
  });
  const token = await createGroup(app);
  const first = await addMember(app, token, { name: '张三', specId: 1, quantity: 6 });
  const second = await addMember(app, token, { name: '李四', specId: 2, quantity: 4 });
  const submitted = await submitGroup(app, token);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO shipments
     (id, order_id, seq, recipient, phone, address, copies, packaging, items_json, crab_cents, packaging_cents, status, created_at, updated_at)
     VALUES (1, ?, 1, '团长', '13800000000', '上海市测试路1号', 1, 'gift', ?, ?, 1000, 'packed', ?, ?)`,
    submitted.order.id,
    JSON.stringify({ copies: 1, items: [{ specId: 1, qty: 6, priceCents: 8800, gender: 'male', weightLabel: '4两' }] }),
    crabCents,
    now,
    now,
  );
  const weights = [
    { memberId: first.id, weightGrams: 1200 },
    { memberId: second.id, weightGrams: 600 },
  ];
  const save = (payload) => app.inject({
    method: 'POST', url: '/api/v1/admin/shipments/1/freight',
    headers: { authorization: 'Bearer dev-admin-token' }, payload,
  });

  // 改价 5000 分远超「运费 999 + 包装费 1000」→ 不许让成员多付
  const tooMuch = await save({
    totalFreightCents: 999,
    memberWeights: weights,
    adjustments: [{ memberId: first.id, freightCents: 5000, reason: '测试超额' }],
  });
  assert.equal(tooMuch.statusCode, 400, tooMuch.body);
  assert.equal(tooMuch.json().error.code, 'FREIGHT_SUM_MISMATCH');

  // 额度内的改价（100 分）：允许，且不再由其他成员补齐差额
  const ok = await save({
    totalFreightCents: 999,
    memberWeights: weights,
    adjustments: [{ memberId: second.id, freightCents: 100, reason: '少发一只' }],
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const shares = ok.json().members.map((m) => m.freightShareCents);
  assert.deepEqual(shares, [666, 100]);
  const collected = shares.reduce((a, b) => a + b, 0);
  assert.ok(collected <= 999 + 1000, '分摊之和不得超过运费 + 包装费');
  assert.equal(ok.json().members[1].freightAdjusted, true);
});
