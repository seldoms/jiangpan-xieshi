import './helpers/selling-season.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';

const LEADER = { 'x-order-code': '团长a1b2' };
const OTHER = { 'x-order-code': '路人c3d4' };

/**
 * 夹具：内存库 + 开放批次 + 一个规格 + 团长/路人两个下单码。
 * 撤销链路全程走 HTTP（软删团 + 撤销订单 + 审计），不注入替身。
 */
async function makeApp(t) {
  const db = createDb(':memory:');
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() + 2 * 3600e3).toISOString();
  db.run(
    "INSERT INTO batches (id, name, cutoff_time, status, created_at) VALUES (1, 't-batch', ?, 'open', ?)",
    cutoff, now,
  );
  db.run("INSERT INTO specs (id, batch_id, gender, weight_label, price_cents, active, sort) VALUES (1, 1, 'male', '4两', 8800, 1, 1)");
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (1, '团长a1b2', '团长', 'active', ?)", now);
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (2, '路人c3d4', '路人', 'active', ?)", now);

  const app = await buildApp({ db });
  t.after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

/** 团长建团并带上自己的配置（团长那条成员记录 submitted_order 恒为 1）。 */
async function createGroupWithLeader(app) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/groups',
    headers: LEADER,
    payload: { title: '待撤销团', initialMember: { name: '团长', items: [{ specId: 1, qty: 5 }] } },
  });
  assert.equal(res.statusCode, 200);
  return res.json().token;
}

function deleteGroup(app, token, headers = LEADER) {
  return app.inject({ method: 'DELETE', url: `/api/v1/groups/${token}`, headers });
}

function myGroups(app, headers = LEADER) {
  return app.inject({ method: 'GET', url: '/api/v1/groups/mine', headers });
}

test('撤销拼团：未登录 401、不存在 404、非团长 403', async (t) => {
  const { app } = await makeApp(t);
  const token = await createGroupWithLeader(app);

  const anonymous = await app.inject({ method: 'DELETE', url: `/api/v1/groups/${token}` });
  assert.equal(anonymous.statusCode, 401);

  const missing = await deleteGroup(app, 'not-a-token');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'GROUP_NOT_FOUND');

  const stranger = await deleteGroup(app, token, OTHER);
  assert.equal(stranger.statusCode, 403);
  assert.equal(stranger.json().error.code, 'NOT_GROUP_LEADER');
});

test('撤销拼团：只有团长自己时可直接撤销，列表和公开页都不再出现', async (t) => {
  const { app, db } = await makeApp(t);
  const token = await createGroupWithLeader(app);

  const before = (await myGroups(app)).json().groups;
  assert.equal(before.length, 1);
  assert.equal(before[0].memberCount, 1);
  assert.equal(before[0].otherMemberCount, 0);

  const res = await deleteGroup(app, token);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().deleted, true);
  assert.equal(res.json().alreadyDeleted, false);
  assert.equal(res.json().revokedOrderNo, null);

  // 软删除：行还在，只是打了 deleted_at
  const row = db.get('SELECT * FROM groups WHERE token = ?', token);
  assert.ok(row, '团记录必须保留（软删除）');
  assert.notEqual(row.deleted_at, null);

  assert.equal((await myGroups(app)).json().groups.length, 0);

  const publicView = await app.inject({ method: 'GET', url: `/api/v1/groups/${token}` });
  assert.equal(publicView.statusCode, 404);

  // 建团本身也会写一条 group.create，这里只关心撤销动作
  const actions = db.all("SELECT action FROM audit_logs WHERE entity = 'groups' AND action = 'group.delete'").map((r) => r.action);
  assert.deepEqual(actions, ['group.delete']);
});

test('撤销拼团：otherMemberCount 能区分团长自己和其他参与者', async (t) => {
  const { app } = await makeApp(t);
  const token = await createGroupWithLeader(app);

  const added = await app.inject({
    method: 'POST',
    url: `/api/v1/groups/${token}/members`,
    payload: { name: '路人', items: [{ specId: 1, qty: 3 }] },
  });
  assert.equal(added.statusCode, 201);

  const group = (await myGroups(app)).json().groups[0];
  assert.equal(group.memberCount, 2, '团长 + 路人');
  assert.equal(group.otherMemberCount, 1, '只有团长自己那条是 1 号，其余算「其他人」');

  // 有人参与也允许撤销：二次确认是前端的事，接口不该拦
  const res = await deleteGroup(app, token);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().deleted, true);
});

test('撤销拼团：已提交的团连同订单一起撤销', async (t) => {
  const { app, db } = await makeApp(t);
  const token = await createGroupWithLeader(app);
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO orders (id, batch_id, seq, order_no, user_id, source, status, crab_cents,
       packaging_cents, freight_cents, total_cents, config_snapshot, created_at)
     VALUES (1, 1, 1, 'D260919-0001', 1, 'group', 'submitted', 8800, 0, NULL, 8800, '{}', ?)`,
    now,
  );
  db.run("UPDATE groups SET status = 'submitted', submitted_order_id = 1 WHERE token = ?", token);

  const res = await deleteGroup(app, token);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().revokedOrderNo, 'D260919-0001');

  const order = db.get('SELECT * FROM orders WHERE id = 1');
  assert.notEqual(order.deleted_at, null, '订单必须一起被撤销');
  assert.equal(db.get('SELECT deleted_at FROM groups WHERE token = ?', token).deleted_at !== null, true);

  // 撤销后用户在「我的订单」里看不到它
  const orders = await app.inject({ method: 'GET', url: '/api/v1/orders', headers: LEADER });
  assert.equal(orders.statusCode, 200);
  assert.equal(orders.json().orders.length, 0);

  // 团删除 + 订单撤销，两条审计
  const actions = db.all("SELECT action, actor_type FROM audit_logs ORDER BY id").map((r) => `${r.actor_type}:${r.action}`);
  assert.deepEqual(actions, ['user:group.create', 'user:order.delete', 'user:group.delete']);
});

test('撤销拼团：已发货的订单不许撤销', async (t) => {
  const { app, db } = await makeApp(t);
  const token = await createGroupWithLeader(app);
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO orders (id, batch_id, seq, order_no, user_id, source, status, crab_cents,
       packaging_cents, freight_cents, total_cents, config_snapshot, created_at)
     VALUES (1, 1, 1, 'D260919-0002', 1, 'group', 'submitted', 8800, 0, NULL, 8800, '{}', ?)`,
    now,
  );
  db.run("UPDATE groups SET status = 'submitted', submitted_order_id = 1 WHERE token = ?", token);
  db.run(
    `INSERT INTO shipments (id, order_id, seq, recipient, phone, address, copies, packaging,
       items_json, crab_cents, packaging_cents, status, created_at, updated_at)
     VALUES (1, 1, 1, '团长', '13800000000', '江都市某路 1 号', 1, 'plain', '[]', 8800, 0, 'shipped', ?, ?)`,
    now, now,
  );

  const res = await deleteGroup(app, token);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'GROUP_SHIPPED');

  // 被拒时两边都不许变
  assert.equal(db.get('SELECT deleted_at FROM groups WHERE token = ?', token).deleted_at, null);
  assert.equal(db.get('SELECT deleted_at FROM orders WHERE id = 1').deleted_at, null);
});

test('撤销拼团：重复调用幂等，不再重复写审计', async (t) => {
  const { app, db } = await makeApp(t);
  const token = await createGroupWithLeader(app);

  assert.equal((await deleteGroup(app, token)).statusCode, 200);
  const again = await deleteGroup(app, token);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().alreadyDeleted, true);

  const deletes = db.all("SELECT id FROM audit_logs WHERE action = 'group.delete'");
  assert.equal(deletes.length, 1);
});
