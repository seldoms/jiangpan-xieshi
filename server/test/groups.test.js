import './helpers/selling-season.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';

const LEADER = { 'x-order-code': '团长a1b2' };
const OTHER = { 'x-order-code': '路人c3d4' };

/**
 * 自建夹具：内存库 + 一个开放批次 + 两个规格 + 两个用户。
 * 提交链路用 app.decorate('createOrder', stub) 替身验证；真实 orderRepo 集成见 integration.test.js。
 */
async function makeApp(t, { cutoffInHours = 2, createOrder = null } = {}) {
  const db = createDb(':memory:');
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() + cutoffInHours * 3600e3).toISOString();
  db.run(
    "INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (1, 't-batch', ?, 'open', ?)",
    cutoff, now,
  );
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (1, 1, 'male', '4两', 8800, 1, 1)");
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (2, 1, 'female', '3两', 7800, 1, 2)");
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (1, '团长a1b2', '团长', 'active', ?)", now);
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (2, '路人c3d4', '路人', 'active', ?)", now);

  const app = await buildApp({ db });
  if (createOrder) app.decorate('createOrder', createOrder); // 必须在首次 inject 前注入
  t.after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

async function createGroup(app, headers = LEADER) {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/groups', headers, payload: { title: '测试拼团' },
  });
  assert.equal(res.statusCode, 200);
  return res.json().token;
}

async function addMember(app, token, payload) {
  return app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/members`, payload,
  });
}

async function viewGroup(app, token) {
  const res = await app.inject({ method: 'GET', url: `/api/v1/groups/${token}` });
  assert.equal(res.statusCode, 200);
  return res.json();
}

test('创建拼团：需要下单码，返回 token 和 open 状态', async (t) => {
  const { app } = await makeApp(t);
  const noAuth = await app.inject({ method: 'POST', url: '/api/v1/groups', payload: { title: 'x' } });
  assert.equal(noAuth.statusCode, 401);

  const res = await app.inject({ method: 'POST', url: '/api/v1/groups', headers: LEADER, payload: { title: '周五团' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'open');
  assert.equal(typeof res.json().token, 'string');
  assert.ok(res.json().token.length >= 16);

  const badTitle = await app.inject({ method: 'POST', url: '/api/v1/groups', headers: LEADER, payload: { title: '' } });
  assert.equal(badTitle.statusCode, 422);
});

test('我的团购：需要登录，只返回本人发起的团，未成团即有链接且不泄露凭据', async (t) => {
  const { app } = await makeApp(t);
  const list = (headers) => app.inject({ method: 'GET', url: '/api/v1/groups/mine', headers });
  assert.equal((await list({})).statusCode, 401);
  assert.deepEqual((await list(LEADER)).json(), { groups: [] });
  const first = await createGroup(app);
  const other = await createGroup(app, OTHER);
  const latest = await createGroup(app);
  await addMember(app, first, { name: '团员', items: [{ specId: 1, qty: 2 }, { specId: 2, qty: 1 }] });
  const response = await list(LEADER);
  assert.equal(response.statusCode, 200);
  const { groups } = response.json();
  assert.deepEqual(groups.map((group) => group.token), [latest, first]);
  assert.equal(groups[0].totalCount, 0);
  assert.equal(groups[1].totalCount, 3);
  assert.equal(groups[1].memberCount, 1);
  assert.equal(groups[1].canSubmit, false);
  assert.equal(groups[1].amount.totalCents, 2 * 8800 + 7800);
  assert.equal(groups[1].amount.phase, 'estimate');
  assert.equal(groups[1].amount.freightCents, null);
  assert.equal(groups[1].batchId, 1);
  assert.ok(groups[1].createdAt);
  assert.ok(groups[1].cutoffTime);
  assert.equal(groups[1].isAfterCutoff, false);
  assert.deepEqual((await list(OTHER)).json().groups.map((group) => group.token), [other]);
  assert.doesNotMatch(response.body, /edit[_]?key|order[_]?code|address|recipient|phone|团长a1b2/i);
});

test('我的团购：达到十只可提交，提交后仍可找回且金额使用订单快照', async (t) => {
  const { app, db } = await makeApp(t);
  const token = await createGroup(app);
  await addMember(app, token, { name: '成员', specId: 1, quantity: 10 });
  const mine = async () => (await app.inject({ method: 'GET', url: '/api/v1/groups/mine', headers: LEADER })).json().groups[0];
  assert.equal((await mine()).canSubmit, true);
  const submitted = await app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/submit`, headers: LEADER,
    payload: { recipient: '收件人', phone: '13800000000', address: '测试市测试路1号', packaging: 'gift' },
  });
  assert.equal(submitted.statusCode, 200, submitted.body);
  db.run('UPDATE specs SET price_cents = 1 WHERE id = 1');
  const group = await mine();
  assert.equal(group.token, token);
  assert.equal(group.status, 'submitted');
  assert.equal(group.canSubmit, false);
  assert.equal(group.orderNo, submitted.json().order.order_no);
  assert.equal(group.amount.phase, 'final');
  assert.equal(group.amount.crabCents, 88000);
  assert.equal(group.amount.packagingCents, submitted.json().order.packaging_cents);
  assert.equal(group.amount.totalCents, submitted.json().order.total_cents);
});

test('成员提交：quantity=0 / 非整数被拒（422）', async (t) => {
  const { app } = await makeApp(t);
  const token = await createGroup(app);

  for (const quantity of [0, -1, 1.5, '2']) {
    const res = await addMember(app, token, { name: '张三', specId: 1, quantity });
    assert.equal(res.statusCode, 422, `quantity=${quantity}`);
    assert.equal(res.json().error.code, 'INVALID_QUANTITY');
  }

  const ok = await addMember(app, token, { name: '张三', specId: 1, quantity: 3 });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().member.quantity, 3);
  assert.equal(ok.json().member.specLabel, '公4两');
  assert.equal(typeof ok.json().editKey, 'string');
});

test('公开视图：汇总、remainingToNextTen、canSubmit，且不含手机号地址', async (t) => {
  const { app } = await makeApp(t);
  const token = await createGroup(app);
  await addMember(app, token, { name: '张三', specId: 1, quantity: 7 });
  await addMember(app, token, { name: '李四', specId: 2, quantity: 6 });

  let view = await viewGroup(app, token);
  assert.equal(view.totalCount, 13);
  assert.equal(view.remainingToNextTen, 7); // 距 20 还差 7
  assert.equal(view.canSubmit, false);
  assert.deepEqual(
    view.totalsBySpec.map((s) => ({ specId: s.specId, quantity: s.quantity })),
    [{ specId: 1, quantity: 7 }, { specId: 2, quantity: 6 }],
  );
  assert.equal(view.members.length, 2);
  assert.equal(view.estimated.crabCents, 7 * 8800 + 6 * 7800);
  assert.equal(view.estimated.boxes, 2); // ceil(13/10)
  assert.equal(view.estimated.totalCents, view.estimated.crabCents); // plain 包装 0

  // 补到 20：可提交
  await addMember(app, token, { name: '王五', specId: 1, quantity: 7 });
  view = await viewGroup(app, token);
  assert.equal(view.totalCount, 20);
  assert.equal(view.remainingToNextTen, 0);
  assert.equal(view.canSubmit, true);

  // 公开视图任何层级都不出现手机号/地址字段
  const raw = JSON.stringify(view);
  assert.ok(!raw.includes('phone') && !raw.includes('address'));
  for (const m of view.members) {
    assert.deepEqual(Object.keys(m).sort(), ['crabCents', 'id', 'items', 'name', 'quantity', 'specId', 'specLabel']);
  }
});

test('提交校验：非 10 倍数 422 GROUP_NOT_READY；非团长 403', async (t) => {
  const { app } = await makeApp(t);
  const token = await createGroup(app);
  await addMember(app, token, { name: '张三', specId: 1, quantity: 10 });
  await addMember(app, token, { name: '李四', specId: 1, quantity: 3 });

  const addr = { recipient: '团长', phone: '13800000000', address: '上海市测试路1号' };

  const notReady = await app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/submit`, headers: LEADER, payload: addr,
  });
  assert.equal(notReady.statusCode, 422);
  assert.equal(notReady.json().error.code, 'GROUP_NOT_READY');

  await addMember(app, token, { name: '王五', specId: 2, quantity: 7 }); // 凑满 20

  const notLeader = await app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/submit`, headers: OTHER, payload: addr,
  });
  assert.equal(notLeader.statusCode, 403);
  assert.equal(notLeader.json().error.code, 'NOT_GROUP_LEADER');

  const noAuth = await app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/submit`, payload: addr,
  });
  assert.equal(noAuth.statusCode, 401);
});

test('团长提交成功：生成订单、结单只读、成员增删改 409', async (t) => {
  // orderRepo 替身：按钉死签名落真实 orders 行（submitted_order_id 有外键）
  const calls = [];
  const { app, db } = await makeApp(t, {
    createOrder: (dbArg, input) => {
      calls.push(input);
      const crab = 12 * 8800 + 8 * 7800;
      const info = dbArg.run(
        `INSERT INTO orders (batch_id, seq, order_no, user_id, source, status, crab_cents, packaging_cents, config_snapshot, idempotency_key, created_at)
         VALUES (?, 1, ?, ?, 'group', 'submitted', ?, 0, '{}', ?, ?)`,
        input.batchId, 'D260919-0001', input.userId, crab, input.idempotencyKey, new Date().toISOString(),
      );
      return {
        order: dbArg.get('SELECT * FROM orders WHERE id = ?', info.lastInsertRowid),
        shipments: [{ id: 1, order_id: info.lastInsertRowid, recipient: input.shipments[0].recipient, copies: input.shipments[0].copies }],
      };
    },
  });
  const token = await createGroup(app);
  await addMember(app, token, { name: '张三', specId: 1, quantity: 12 });
  await addMember(app, token, { name: '李四', specId: 2, quantity: 8 });

  const res = await app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/submit`, headers: LEADER,
    payload: { recipient: '团长', phone: '13800000000', address: '上海市测试路1号', packaging: 'plain' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().group.status, 'submitted');
  assert.equal(res.json().order.order_no, 'D260919-0001');
  const orderId = res.json().order.id;

  // 复用契约：source=group、items 按规格聚合（自定义模式 copies=null，盒数由总只数推导）
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, 'group');
  assert.equal(calls[0].shipments.length, 1);
  assert.equal(calls[0].shipments[0].copies, null);
  assert.deepEqual(calls[0].shipments[0].items, [
    { specId: 1, qty: 12, gender: 'male', weightLabel: '4两' },
    { specId: 2, qty: 8, gender: 'female', weightLabel: '3两' },
  ]);
  assert.equal(typeof calls[0].idempotencyKey, 'string');

  // groups 表已更新，审计已写
  const row = db.get('SELECT * FROM groups WHERE token = ?', token);
  assert.equal(row.status, 'submitted');
  assert.equal(row.submitted_order_id, orderId);
  assert.equal(row.address_phone, '13800000000');
  const audit = db.get("SELECT * FROM audit_logs WHERE entity = 'groups' AND action = 'group.submit'");
  assert.ok(audit);

  // 结单后只读
  const add = await addMember(app, token, { name: '新人', specId: 1, quantity: 1 });
  assert.equal(add.statusCode, 409);
  const view = await viewGroup(app, token);
  const mid = view.members[0].id;
  const put = await app.inject({
    method: 'PUT', url: `/api/v1/groups/${token}/members/${mid}`,
    headers: { 'x-edit-key': 'whatever' }, payload: { quantity: 5 },
  });
  assert.equal(put.statusCode, 409);
  const del = await app.inject({
    method: 'DELETE', url: `/api/v1/groups/${token}/members/${mid}`,
    headers: { 'x-edit-key': 'whatever' },
  });
  assert.equal(del.statusCode, 409);

  // 重复提交（同幂等键，未显式传 key 时路由用 group token 派生同一键）→ 返回同一订单
  const again = await app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/submit`, headers: LEADER,
    payload: { recipient: '团长', phone: '13800000000', address: '上海市测试路1号' },
  });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().order.id, orderId);
  assert.equal(calls.length, 1); // 未再次调用 createOrder
});

test('编辑凭据：错误的 X-Edit-Key 不能改/删别人记录（403），正确凭据可改可删', async (t) => {
  const { app } = await makeApp(t);
  const token = await createGroup(app);
  const a = await addMember(app, token, { name: '张三', specId: 1, quantity: 5 });
  const b = await addMember(app, token, { name: '李四', specId: 2, quantity: 5 });
  const aId = a.json().member.id;
  const aKey = a.json().editKey;
  const bId = b.json().member.id;
  const bKey = b.json().editKey;

  // 缺凭据
  const noKey = await app.inject({
    method: 'PUT', url: `/api/v1/groups/${token}/members/${aId}`, payload: { quantity: 6 },
  });
  assert.equal(noKey.statusCode, 403);
  assert.equal(noKey.json().error.code, 'EDIT_KEY_REQUIRED');

  // 拿 B 的凭据改 A 的记录
  const wrongKey = await app.inject({
    method: 'PUT', url: `/api/v1/groups/${token}/members/${aId}`,
    headers: { 'x-edit-key': bKey }, payload: { quantity: 6 },
  });
  assert.equal(wrongKey.statusCode, 403);
  assert.equal(wrongKey.json().error.code, 'EDIT_KEY_INVALID');

  // 正确凭据修改
  const ok = await app.inject({
    method: 'PUT', url: `/api/v1/groups/${token}/members/${aId}`,
    headers: { 'x-edit-key': aKey }, payload: { quantity: 6, specId: 2 },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().member.quantity, 6);
  assert.equal(ok.json().member.specLabel, '母3两');

  // 正确凭据删除
  const del = await app.inject({
    method: 'DELETE', url: `/api/v1/groups/${token}/members/${bId}`,
    headers: { 'x-edit-key': bKey },
  });
  assert.equal(del.statusCode, 204);
  const view = await viewGroup(app, token);
  assert.equal(view.members.length, 1);
  assert.equal(view.totalCount, 6);
});

test('截单后：成员提交 409，提交订单 409，视图 isAfterCutoff=true', async (t) => {
  const { app, db } = await makeApp(t);
  const token = await createGroup(app);
  db.run('UPDATE batches SET cutoff_time = ? WHERE id = 1', new Date(Date.now() - 1000).toISOString());

  const add = await addMember(app, token, { name: '张三', specId: 1, quantity: 10 });
  assert.equal(add.statusCode, 409);
  assert.equal(add.json().error.code, 'CUTOFF_PASSED');

  const view = await viewGroup(app, token);
  assert.equal(view.isAfterCutoff, true);
  assert.equal(view.canSubmit, false);
});

test('截单后团长提交被拒（409 CUTOFF_PASSED）', async (t) => {
  const { app, db } = await makeApp(t, { cutoffInHours: 2 });
  const token = await createGroup(app);
  await addMember(app, token, { name: '张三', specId: 1, quantity: 10 });
  // 把批次截单时间拨到过去
  db.run('UPDATE batches SET cutoff_time = ? WHERE id = 1', new Date(Date.now() - 1000).toISOString());

  const res = await app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/submit`, headers: LEADER,
    payload: { recipient: '团长', phone: '13800000000', address: '上海市测试路1号' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'CUTOFF_PASSED');
});

test('金额构成：结单前按当前价估算，结单后按快照价并含成员分摊字段', async (t) => {
  const { app, db } = await makeApp(t, {
    createOrder: (dbArg, input) => {
      const crab = 6 * 8800 + 4 * 7800;
      const info = dbArg.run(
        `INSERT INTO orders (batch_id, seq, order_no, user_id, source, status, crab_cents, packaging_cents, config_snapshot, idempotency_key, created_at)
         VALUES (?, 1, ?, ?, 'group', 'submitted', ?, 0, '{}', ?, ?)`,
        input.batchId, 'D260919-0002', input.userId, crab, input.idempotencyKey, new Date().toISOString(),
      );
      return { order: dbArg.get('SELECT * FROM orders WHERE id = ?', info.lastInsertRowid), shipments: [] };
    },
  });
  const token = await createGroup(app);
  await addMember(app, token, { name: '张三', specId: 1, quantity: 6 });
  await addMember(app, token, { name: '李四', specId: 2, quantity: 4 });

  const before = await app.inject({ method: 'GET', url: `/api/v1/groups/${token}/amount` });
  assert.equal(before.statusCode, 200);
  assert.equal(before.json().phase, 'estimate');
  assert.equal(before.json().crabCents, 6 * 8800 + 4 * 7800);
  assert.equal(before.json().freightCents, null);
  assert.equal(before.json().members.length, 2);
  assert.equal(before.json().members[0].crabCents, 6 * 8800);
  assert.equal(before.json().members[0].freightShareCents, null);

  await app.inject({
    method: 'POST', url: `/api/v1/groups/${token}/submit`, headers: LEADER,
    payload: { recipient: '团长', phone: '13800000000', address: '上海市测试路1号' },
  });

  // 规格现价改动不影响快照口径
  db.run('UPDATE specs SET price_cents = 1 WHERE id = 1');
  const after = await app.inject({ method: 'GET', url: `/api/v1/groups/${token}/amount` });
  assert.equal(after.statusCode, 200);
  assert.equal(after.json().phase, 'final');
  assert.equal(after.json().members[0].crabCents, 6 * 8800);
  assert.equal(after.json().members[1].crabCents, 4 * 7800);

  // 录入成员分摊运费后可见
  const view = await viewGroup(app, token);
  db.run('UPDATE group_members SET freight_share_cents = 600 WHERE id = ?', view.members[0].id);
  db.run('UPDATE group_members SET freight_share_cents = 400 WHERE id = ?', view.members[1].id);
  const shipped = await app.inject({ method: 'GET', url: `/api/v1/groups/${token}/amount` });
  assert.equal(shipped.json().members[0].freightShareCents, 600);
  assert.equal(shipped.json().members[0].totalCents, 6 * 8800 + 600);
});

test('混合配置：一个成员提交多规格、重复规格合并、可整体编辑且不能退化为单规格', async (t) => {
  const { app } = await makeApp(t);
  const token = await createGroup(app);
  const added = await addMember(app, token, {
    name: '混合成员', items: [{ specId: 1, qty: 2 }, { specId: 2, qty: 3 }, { specId: 1, qty: 1 }],
  });
  assert.equal(added.statusCode, 201);
  const { member, editKey } = added.json();
  assert.equal(member.quantity, 6);
  assert.equal(member.crabCents, 3 * 8800 + 3 * 7800);
  assert.equal(member.specLabel, '公4两 × 3 + 母3两 × 3');
  assert.deepEqual(member.items.map(({ specId, qty }) => ({ specId, qty })), [{ specId: 1, qty: 3 }, { specId: 2, qty: 3 }]);
  const view = await viewGroup(app, token);
  assert.equal(view.members.length, 1);
  assert.equal(view.totalCount, 6);
  assert.equal(view.remainingToNextTen, 4);
  const edit = (payload) => app.inject({
    method: 'PUT', url: `/api/v1/groups/${token}/members/${member.id}`,
    headers: { 'x-edit-key': editKey }, payload,
  });
  assert.equal((await edit({ quantity: 10 })).statusCode, 422);
  const rename = await edit({ name: '新名字' });
  assert.equal(rename.json().member.items.length, 2);
  const updated = await edit({ items: [{ specId: 1, qty: 6 }, { specId: 2, qty: 4 }] });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().member.quantity, 10);
  assert.equal((await viewGroup(app, token)).canSubmit, true);
});

test('混合配置校验：空列表、非法数量、失效规格不得落库', async (t) => {
  const { app, db } = await makeApp(t);
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (3, 1, 'male', '5两', 100, 0, 3)");
  const token = await createGroup(app);
  for (const items of [[], null, [{ specId: 1, qty: 0 }], [{ specId: 1, qty: 1.5 }], [{ specId: 999, qty: 1 }], [{ specId: 3, qty: 1 }], [{ specId: 1, qty: Number.MAX_SAFE_INTEGER }]]) {
    const response = await addMember(app, token, { name: '不应落库', items });
    assert.equal(response.statusCode, 422);
  }
  assert.equal((await viewGroup(app, token)).members.length, 0);
});

test('建团原子继承采购配置：无效配置回滚，截单后新团进入下一批次', async (t) => {
  const { app, db } = await makeApp(t);
  const payload = { title: '继承配置', initialMember: { name: '团长', items: [{ specId: 1, qty: 2 }, { specId: 2, qty: 3 }] } };
  const create = () => app.inject({ method: 'POST', url: '/api/v1/groups', headers: LEADER, payload });
  const result = await create();
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().member.quantity, 5);
  assert.ok(result.json().editKey);
  assert.equal((await viewGroup(app, result.json().token)).totalCount, 5);
  payload.initialMember.items = [{ specId: 999, qty: 1 }];
  assert.equal((await create()).statusCode, 422);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM groups').count, 1);
  db.run('UPDATE batches SET cutoff_time = ? WHERE id = 1', new Date(Date.now() - 1000).toISOString());
  payload.initialMember.items = [{ specId: 1, qty: 1 }];
  const next = await create();
  assert.equal(next.statusCode, 200);
  assert.equal(db.get('SELECT batch_id FROM groups WHERE token = ?', next.json().token).batch_id, 2);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM groups').count, 2);
});

test('历史单规格快照兼容：公开配置与金额照常富化', async (t) => {
  const { app, db } = await makeApp(t);
  const token = await createGroup(app);
  const groupId = db.get('SELECT id FROM groups WHERE token = ?', token).id;
  db.run(`INSERT INTO group_members (group_id, name, spec_id, spec_snapshot, quantity, submitted_order, edit_key, created_at)
    VALUES (?, '历史成员', 1, ?, 3, 1, 'old-key', ?)`, groupId,
  JSON.stringify({ specId: 1, gender: 'male', weightLabel: '4两', label: '公4两', priceCents: 8800 }), new Date().toISOString());
  const view = await viewGroup(app, token);
  assert.equal(view.members[0].items[0].qty, 3);
  assert.equal(view.estimated.crabCents, 26400);
});
