import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { provisionSuperadmin } from '../scripts/provision-superadmin.js';

async function fixture(t) {
  const db = createDb(':memory:');
  const app = await buildApp({ db, env: {} });
  t.after(async () => { await app.close(); db.close(); });
  db.run("INSERT INTO users (order_code, display_name, created_at) VALUES ('normal', '普通用户', ?)", new Date().toISOString());
  provisionSuperadmin(db, 'sampleadmin');
  db.run("INSERT INTO admin_users (name, token, role, created_at) VALUES ('中文管理员', '管理甲', 'admin', ?)", new Date().toISOString());
  return { app, db };
}

test('统一登录返回服务端角色，普通用户不能通过自报角色提权', async (t) => {
  const { app } = await fixture(t);
  const login = (orderCode, role) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orderCode, role } });
  assert.equal((await login('sampleadmin')).json().user.role, 'superadmin');
  assert.equal((await login('管理甲')).json().user.role, 'admin');
  const ordinary = (await login('normal', 'superadmin')).json().user;
  assert.equal(ordinary.role, 'user');
  assert.equal((await login('WRONG')).statusCode, 200);
  assert.equal((await login('wrong')).json().user.id > 0, true);
});

test('超级管理员下单码可管理读写，中文编码和旧 Bearer 均兼容', async (t) => {
  const { app } = await fixture(t);
  const headers = { 'x-order-code': 'sampleadmin' };
  const created = await app.inject({ method: 'POST', url: '/api/v1/admin/specs', headers, payload: { gender: 'male', weightLabel: '4两', priceCents: 200 } });
  assert.equal(created.statusCode, 201);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/specs', headers })).json().specs.length, 1);
  for (const validHeaders of [
    { 'x-order-code': encodeURIComponent('管理甲') },
    { authorization: 'Bearer sampleadmin' },
    { authorization: 'Bearer dev-admin-token' },
  ]) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/settings', headers: validHeaders })).statusCode, 200);
  }
});

test('普通码、错误码、坏编码和无效管理员角色不得访问后台', async (t) => {
  const { app, db } = await fixture(t);
  db.run("INSERT INTO admin_users (name, token, role, created_at) VALUES ('viewer', 'viewercode', 'viewer', ?)", new Date().toISOString());
  for (const code of ['normal', 'wrong', '%ZZ']) {
    const result = await app.inject({ method: 'PUT', url: '/api/v1/admin/settings', headers: { 'x-order-code': code, 'x-role': 'superadmin' }, payload: { role: 'superadmin', 'packaging.gift': 0 } });
    assert.equal(result.statusCode, 401);
  }
  for (const headers of [{ 'x-order-code': 'viewercode' }, { authorization: 'Bearer viewercode' }]) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/settings', headers })).statusCode, 403);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orderCode: 'viewercode' } })).statusCode, 403);
});

test('显式初始化幂等且不覆盖普通用户或冲突管理员', async () => {
  const db = createDb(':memory:');
  try {
    const first = provisionSuperadmin(db, 'sampleadmin');
    const second = provisionSuperadmin(db, 'sampleadmin');
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.id, second.id);
    db.run("INSERT INTO users (order_code, display_name, created_at) VALUES ('normal', '普通用户', ?)", new Date().toISOString());
    assert.throws(() => provisionSuperadmin(db, 'normal'), /拒绝覆盖/);
    db.run("INSERT INTO admin_users (name, token, role, created_at) VALUES ('admin', 'admin', 'admin', ?)", new Date().toISOString());
    assert.throws(() => provisionSuperadmin(db, 'admin'), /拒绝覆盖/);
    assert.equal(db.get("SELECT role FROM admin_users WHERE token = 'admin'").role, 'admin');
  } finally { db.close(); }
});
