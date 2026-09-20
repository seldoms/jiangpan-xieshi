import './helpers/selling-season.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';

/**
 * 端到端集成：内存库 + buildApp 全量路由 + app.inject，不 mock 任何 repository。
 *
 * 夹具：批次 1（截单在未来）、规格 1 公4两 8800 / 规格 2 母3两 7800、
 * 礼盒套餐模板 1（5公5母）、用户 1 codeusera / 用户 2 codeuserb、
 * settings 包装价 plain=0 / gift=1000。
 *
 * 覆盖：登录 → 配置 → 个人下单（3 份礼盒）→ 幂等重发 → 管理端汇总/状态推进/录运费
 * → 用户查看运费与合计 → 拼团全流程（创建/成员/团长提交/拼团运费分摊/金额构成）
 * → 软删除后汇总不再统计。
 */

const USER_A = { 'x-order-code': 'codeusera' };
const USER_B = { 'x-order-code': 'codeuserb' };
const ADMIN = { authorization: 'Bearer dev-admin-token' };

async function makeApp(t) {
  const db = createDb(':memory:');
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() + 24 * 3600e3).toISOString();

  db.run("INSERT INTO settings (key, value) VALUES ('packaging.plain', '0')");
  db.run("INSERT INTO settings (key, value) VALUES ('packaging.gift', '1000')");
  db.run(
    "INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (1, 'it-batch', ?, 'open', ?)",
    cutoff, now,
  );
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (1, 1, 'male', '4两', 8800, 1, 1)");
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (2, 1, 'female', '3两', 7800, 1, 2)");
  db.run(
    "INSERT INTO package_templates (id, name, packaging, active, created_at) VALUES (1, '5公5母礼盒', 'gift', 1, ?)",
    now,
  );
  db.run('INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (1, 1, 5)');
  db.run('INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (1, 2, 5)');
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (1, 'codeusera', '用户A', 'active', ?)", now);
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (2, 'codeuserb', '用户B', 'active', ?)", now);

  const app = await buildApp({ db, env: {} });
  t.after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

// 套餐单价：5×8800 + 5×7800 = 83000 分/份
const PER_COPY_CRAB = 5 * 8800 + 5 * 7800;

test('端到端：个人下单 → 履约 → 拼团 → 软删除', async (t) => {
  const { app } = await makeApp(t);

  // b) 登录 → 当前配置 → 下 3 份礼盒套餐
  const login = await app.inject({
    method: 'POST', url: '/api/v1/auth/login', payload: { orderCode: 'codeusera' },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().user.id, 1);

  const config = await app.inject({ method: 'GET', url: '/api/v1/config/current' });
  assert.equal(config.statusCode, 200);
  assert.equal(config.json().batch.id, 1);
  assert.equal(config.json().batch.isAfterCutoff, false);
  assert.equal(config.json().specs.length, 2);
  assert.equal(config.json().templates.length, 1);
  assert.equal(config.json().packagingPrices.gift, 1000);

  const create = await app.inject({
    method: 'POST', url: '/api/v1/orders', headers: USER_A,
    payload: {
      idempotencyKey: 'it-personal-1',
      shipments: [{
        templateId: 1, copies: 3,
        recipient: '张三', phone: '13800000000', address: '上海市黄浦区测试路1号',
      }],
    },
  });
  assert.equal(create.statusCode, 201);
  const { order, shipments } = create.json();
  assert.match(order.orderNo, /^D\d{6}-\d{4}$/);
  assert.equal(order.amount.crabCents, PER_COPY_CRAB * 3);
  assert.equal(order.amount.packagingCents, 3000); // 3 盒 × 1000
  assert.equal(order.amount.totalCents, PER_COPY_CRAB * 3 + 3000);
  assert.equal(shipments.length, 1);
  assert.equal(shipments[0].copies, 3);
  assert.equal(shipments[0].boxes, 3);
  // 写侧富化：items 携带 gender/weightLabel 快照
  assert.deepEqual(
    shipments[0].items.map(({ specId, qty, gender, weightLabel }) => ({ specId, qty, gender, weightLabel })),
    [
      { specId: 1, qty: 5, gender: 'male', weightLabel: '4两' },
      { specId: 2, qty: 5, gender: 'female', weightLabel: '3两' },
    ],
  );

  // c) 同一 idempotencyKey 重发 → 200 且同一订单
  const retry = await app.inject({
    method: 'POST', url: '/api/v1/orders', headers: USER_A,
    payload: {
      idempotencyKey: 'it-personal-1',
      shipments: [{
        templateId: 1, copies: 3,
        recipient: '张三', phone: '13800000000', address: '上海市黄浦区测试路1号',
      }],
    },
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().order.id, order.id);
  assert.equal(retry.json().order.orderNo, order.orderNo);

  // d) 管理端汇总 → 状态推进 → 录运费 → 用户查看合计
  const summary1 = await app.inject({
    method: 'GET', url: '/api/v1/admin/batch/summary', headers: ADMIN,
  });
  assert.equal(summary1.statusCode, 200);
  assert.equal(summary1.json().orderCount, 1);
  const sumOf = (body, gender, weightLabel) =>
    body.totalsBySpec.find((x) => x.gender === gender && x.weightLabel === weightLabel)?.quantity ?? 0;
  assert.equal(sumOf(summary1.json(), 'male', '4两'), 15); // 5 × 3 份
  assert.equal(sumOf(summary1.json(), 'female', '3两'), 15);

  const cards = await app.inject({ method: 'GET', url: '/api/v1/admin/shipments', headers: ADMIN });
  assert.equal(cards.statusCode, 200);
  const shipmentId = cards.json().shipments[0].id;
  assert.equal(cards.json().shipments[0].status, 'fishing');

  for (const to of ['packed']) {
    const tr = await app.inject({
      method: 'POST', url: `/api/v1/admin/shipments/${shipmentId}/transition`,
      headers: ADMIN, payload: { to },
    });
    assert.equal(tr.statusCode, 200, `transition -> ${to}`);
    assert.equal(tr.json().status, to);
  }

  const freight = await app.inject({
    method: 'POST', url: `/api/v1/admin/shipments/${shipmentId}/freight`,
    headers: ADMIN, payload: { weightGrams: 2400, freightCents: 3600 },
  });
  assert.equal(freight.statusCode, 200);
  assert.equal(freight.json().shipment.status, 'shipped');
  assert.equal(freight.json().order.freightCents, 3600);

  const detail = await app.inject({ method: 'GET', url: `/api/v1/orders/${order.id}`, headers: USER_A });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().order.amount.freightCents, 3600);
  assert.equal(detail.json().order.amount.totalCents, PER_COPY_CRAB * 3 + 3000 + 3600);
  assert.equal(detail.json().shipments[0].amount.freightCents, 3600);
  assert.equal(detail.json().shipments[0].status, 'shipped');

  // e) 拼团全流程：创建 → 两个成员共 20 只 → 团长提交 → 拼团运费分摊
  const groupRes = await app.inject({
    method: 'POST', url: '/api/v1/groups', headers: USER_B, payload: { title: '同事团' },
  });
  assert.equal(groupRes.statusCode, 200);
  const token = groupRes.json().token;

  const m1 = await app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/members`,
    payload: { name: '成员甲', specId: 1, quantity: 10 },
  });
  assert.equal(m1.statusCode, 201);
  const m2 = await app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/members`,
    payload: { name: '成员乙', specId: 2, quantity: 10 },
  });
  assert.equal(m2.statusCode, 201);

  const view = await app.inject({ method: 'GET', url: `/api/v1/groups/${token}` });
  assert.equal(view.json().totalCount, 20);
  assert.equal(view.json().canSubmit, true);

  const submit = await app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/submit`, headers: USER_B,
    payload: { recipient: '李四', phone: '13900000000', address: '江苏省苏州市测试路2号', packaging: 'plain' },
  });
  assert.equal(submit.statusCode, 200);
  assert.equal(submit.json().group.status, 'submitted');
  const groupOrder = submit.json().order;
  const groupShipmentId = submit.json().shipments[0].id;
  // 自定义模式：蟹款 = Σ price×qty（不乘份数），盒数 = 20/10 = 2
  assert.equal(groupOrder.crab_cents, 10 * 8800 + 10 * 7800);
  assert.equal(groupOrder.packaging_cents, 0);
  assert.equal(submit.json().shipments[0].copies, 2);

  const groupPacked = await app.inject({
    method: 'POST', url: `/api/v1/admin/shipments/${groupShipmentId}/transition`,
    headers: ADMIN, payload: { to: 'packed' },
  });
  assert.equal(groupPacked.statusCode, 200);

  const gFreight = await app.inject({
    method: 'POST', url: `/api/v1/admin/shipments/${groupShipmentId}/freight`,
    headers: ADMIN,
    payload: {
      totalFreightCents: 999,
      memberWeights: [
        { memberId: m1.json().member.id, weightGrams: 500 },
        { memberId: m2.json().member.id, weightGrams: 500 },
      ],
    },
  });
  assert.equal(gFreight.statusCode, 200);
  assert.equal(gFreight.json().shipment.status, 'shipped');
  const gMembers = gFreight.json().members;
  const gFreightSum = gMembers.reduce((sum, m) => sum + m.freightShareCents, 0);
  // 抹零口径：Σ 成员分摊 <= 拼团总运费，零头由平台承担（只丢分位）
  assert.ok(gFreightSum <= 999, '成员分摊之和不得超过拼团总运费');
  assert.ok(999 - gFreightSum < gMembers.length, '抹零差额必须小于成员数');
  assert.equal(gFreightSum, 998); // floor 后抹零 1 分
  assert.equal(gFreight.json().order.freightCents, 999);

  const amount = await app.inject({ method: 'GET', url: `/api/v1/groups/${token}/amount` });
  assert.equal(amount.statusCode, 200);
  assert.equal(amount.json().phase, 'final');
  assert.equal(amount.json().orderId, groupOrder.id);
  assert.equal(amount.json().freightCents, 999);
  const amountSum = amount.json().members.reduce((sum, m) => sum + m.freightShareCents, 0);
  assert.ok(amountSum <= 999, '金额接口的成员分摊之和不得超过拼团总运费');
  assert.equal(amountSum, gFreightSum, '用户端与管理端必须看到同一份分摊');
  // 合并均摊：包装费 + 运费两项之和 = 该成员分摊到的那一份
  for (const m of amount.json().members) {
    assert.equal(
      m.packagingShareCents + m.freightShareCents,
      m.totalCents - m.crabCents,
    );
  }
  assert.equal(amount.json().members[0].crabCents, 10 * 8800);
  assert.equal(amount.json().members[1].crabCents, 10 * 7800);

  // f) 软删除个人订单后，批次汇总不再统计该订单
  const del = await app.inject({
    method: 'DELETE', url: `/api/v1/admin/orders/${order.id}`,
    headers: ADMIN, payload: { reason: '集成测试清理' },
  });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().deleted, true);

  const summary2 = await app.inject({
    method: 'GET', url: '/api/v1/admin/batch/summary', headers: ADMIN,
  });
  assert.equal(summary2.json().orderCount, 1); // 只剩拼团订单
  assert.equal(sumOf(summary2.json(), 'male', '4两'), 10);
  assert.equal(sumOf(summary2.json(), 'female', '3两'), 10);

  // 被删订单对用户侧 404
  const gone = await app.inject({ method: 'GET', url: `/api/v1/orders/${order.id}`, headers: USER_A });
  assert.equal(gone.statusCode, 404);
});

test('混合拼团端到端：一个人多规格 → 调价结单冻结 → 总量捕捞 → 按成员总实重分摊运费', async (t) => {
  const { app, db } = await makeApp(t);
  const created = await app.inject({ method: 'POST', url: '/api/v1/groups', headers: USER_A, payload: {
    title: '混合采购团', initialMember: { name: '团长', items: [{ specId: 1, qty: 2 }, { specId: 2, qty: 3 }] },
  } });
  assert.equal(created.statusCode, 200);
  const { token, member: leader } = created.json();
  const added = await app.inject({ method: 'POST', url: `/api/v1/groups/${token}/members`, payload: {
    name: '团员', items: [{ specId: 1, qty: 4 }, { specId: 2, qty: 1 }],
  } });
  assert.equal(added.statusCode, 201);
  const member = added.json().member;
  db.run('UPDATE specs SET price_cents = 9000 WHERE id = 1');
  const submitted = await app.inject({ method: 'POST', url: `/api/v1/groups/${token}/submit`, headers: USER_A, payload: {
    recipient: '团长', phone: '13800000000', address: '江苏省扬州市测试路1号', packaging: 'gift',
  } });
  assert.equal(submitted.statusCode, 200);
  const shipmentId = submitted.json().shipments[0].id;
  assert.equal(submitted.json().order.crab_cents, 6 * 9000 + 4 * 7800);
  const summary = await app.inject({ method: 'GET', url: '/api/v1/admin/batch/summary', headers: ADMIN });
  assert.deepEqual(summary.json().totalsBySpec, [
    { gender: 'female', weightLabel: '3两', quantity: 4 },
    { gender: 'male', weightLabel: '4两', quantity: 6 },
  ]);
  db.run('UPDATE specs SET price_cents = 1');
  const readAmount = async () => (await app.inject({ method: 'GET', url: `/api/v1/groups/${token}/amount` })).json();
  const frozen = await readAmount();
  assert.equal(frozen.members[0].crabCents, 2 * 9000 + 3 * 7800);
  assert.equal(frozen.members[1].crabCents, 4 * 9000 + 7800);
  // 结单后未录运费：只分摊包装费，运费行必须为 null（不凭空造运费）
  assert.deepEqual(frozen.members.map((m) => m.freightShareCents), [null, null]);
  const frozenSum = frozen.members.reduce((sum, m) => sum + m.totalCents, 0);
  assert.ok(frozenSum <= frozen.totalCents, '成员合计不得超过订单总额');
  assert.ok(
    frozen.totalCents - frozenSum < frozen.members.length,
    '抹零差额必须小于成员数',
  );
  const pkgShareSum = frozen.members.reduce((sum, m) => sum + m.packagingShareCents, 0);
  assert.ok(pkgShareSum <= frozen.packagingCents, '包装费分摊之和不得超过包装费总额');
  assert.ok(frozen.packagingCents - pkgShareSum < frozen.members.length);
  const publicView = (await app.inject({ method: 'GET', url: `/api/v1/groups/${token}` })).json();
  assert.equal(publicView.members[0].items[0].priceCents, 9000);
  assert.equal(publicView.members[0].items.length, 2);
  await app.inject({ method: 'POST', url: `/api/v1/admin/shipments/${shipmentId}/transition`, headers: ADMIN, payload: { to: 'packed' } });
  const freight = await app.inject({ method: 'POST', url: `/api/v1/admin/shipments/${shipmentId}/freight`, headers: ADMIN, payload: {
    totalFreightCents: 1800, memberWeights: [{ memberId: leader.id, weightGrams: 850 }, { memberId: member.id, weightGrams: 950 }],
  } });
  assert.equal(freight.statusCode, 200);
  assert.equal(freight.json().shipment.status, 'shipped');
  const final = await readAmount();
  assert.equal(final.members[0].freightShareCents, 850);
  assert.equal(final.members[1].freightShareCents, 950);
  // 合并均摊：包装费 + 运费两项之和 = 该成员分摊到的那一份
  for (const m of final.members) {
    assert.equal(m.packagingShareCents + m.freightShareCents, m.totalCents - m.crabCents);
  }
  const finalSum = final.members.reduce((sum, m) => sum + m.totalCents, 0);
  assert.ok(finalSum <= final.totalCents, '成员合计不得超过订单总额');
  assert.ok(final.totalCents - finalSum < final.members.length, '抹零差额必须小于成员数');
  assert.equal(final.totalCents - finalSum, 1); // 抹零 1 分，平台承担
});
