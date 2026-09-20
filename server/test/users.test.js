import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { provisionSuperadmin } from '../scripts/provision-superadmin.js';

async function fixture(t) {
  const db = createDb(':memory:');
  const app = await buildApp({ db, env: {} });
  t.after(async () => { await app.close(); db.close(); });
  provisionSuperadmin(db, 'sampleadmin');
  const admin = { 'x-order-code': 'sampleadmin' };
  return { app, db, admin };
}

const login = (app, orderCode) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orderCode } });

test('登录写入 last_login_at，用户列表带下单统计', async (t) => {
  const { app, db, admin } = await fixture(t);
  assert.equal((await login(app, '张三a1')).statusCode, 200);
  assert.equal((await login(app, '李四')).statusCode, 200);

  const res = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: admin });
  assert.equal(res.statusCode, 200);
  const users = res.json().users;
  assert.equal(users.length, 2);
  const zhang = users.find((u) => u.orderCode === '张三a1');
  assert.ok(zhang.lastLoginAt, '登录后应记录 last_login_at');
  assert.equal(zhang.orderCount, 0);
  assert.equal(zhang.spendCents, 0);

  const again = db.get("SELECT last_login_at FROM users WHERE order_code = '张三a1'");
  assert.ok(again.last_login_at);
});

test('软删除用户：列表消失、不能登录、订单级联软删、审计留痕', async (t) => {
  const { app, db, admin } = await fixture(t);
  const loginRes = await login(app, '王五');
  const userId = loginRes.json().user.id;

  // 造一张该用户的订单（直接插库，绕过下单流程的细节）
  db.run("INSERT INTO batches (name, cutoff_time, status, created_at) VALUES ('测试批', ?, 'open', ?)",
    new Date(Date.now() + 3600e3).toISOString(), new Date().toISOString());
  const batch = db.get("SELECT id FROM batches WHERE name = '测试批'");
  db.run(`INSERT INTO orders (batch_id, seq, order_no, user_id, source, status, crab_cents, packaging_cents, total_cents, config_snapshot, created_at)
          VALUES (?, 1, 'T001', ?, 'personal', 'submitted', 10000, 0, 10000, '{}', ?)`,
    batch.id, userId, new Date().toISOString());

  const listBefore = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: admin });
  const row = listBefore.json().users.find((u) => u.id === userId);
  assert.equal(row.orderCount, 1);
  assert.equal(row.spendCents, 10000);

  const del = await app.inject({ method: 'DELETE', url: `/api/v1/admin/users/${userId}`, headers: admin });
  assert.equal(del.statusCode, 200);

  // 用户列表不再出现
  const listAfter = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: admin });
  assert.equal(listAfter.json().users.some((u) => u.id === userId), false);
  // 登录被拒（不能重新注册同名码回来）
  const relogin = await login(app, '王五');
  assert.equal(relogin.statusCode, 403);
  assert.equal(relogin.json().error.code, 'ORDER_CODE_DELETED');
  // requireUser 路径同样拒绝
  const orders = await app.inject({ method: 'GET', url: '/api/v1/orders', headers: { 'x-order-code': '王五' } });
  assert.equal(orders.statusCode, 403);
  // 订单级联软删：管理端批次汇总不再统计
  assert.ok(db.get('SELECT deleted_at FROM orders WHERE user_id = ?', userId).deleted_at);
  const summary = await app.inject({ method: 'GET', url: '/api/v1/admin/batch/summary', headers: admin });
  assert.equal(summary.json().orderCount, 0);
  // 审计留痕
  const audit = db.get("SELECT * FROM audit_logs WHERE action = 'user.delete' AND entity_id = ?", userId);
  assert.ok(audit);
  // 重复删除报 409
  const twice = await app.inject({ method: 'DELETE', url: `/api/v1/admin/users/${userId}`, headers: admin });
  assert.equal(twice.statusCode, 409);
});

test('用户管理接口需要管理员权限', async (t) => {
  const { app } = await fixture(t);
  await login(app, '普通人');
  const anon = await app.inject({ method: 'GET', url: '/api/v1/admin/users' });
  assert.equal(anon.statusCode, 401);
  const asUser = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: { 'x-order-code': '普通人' } });
  assert.equal(asUser.statusCode, 401);
  const del = await app.inject({ method: 'DELETE', url: '/api/v1/admin/users/1', headers: { 'x-order-code': '普通人' } });
  assert.equal(del.statusCode, 401);
});
