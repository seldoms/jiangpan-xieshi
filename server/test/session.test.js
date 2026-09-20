import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { createSession, findActiveSession, purgeExpired, deleteSessionsForActor } from '../src/repositories/sessionRepo.js';
import { readCookie, buildSessionCookie, buildClearedCookie } from '../src/cookies.js';

const USER_CODE = '会话用户a1';
const ADMIN_TOKEN = 'adminsessiontoken1';

async function makeApp(t) {
  const db = createDb(':memory:');
  const now = new Date().toISOString();
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (1, ?, '会话用户', 'active', ?)", USER_CODE, now);
  db.run("INSERT INTO users (id, order_code, display_name, status, created_at) VALUES (2, '停用用户b2', '停用用户', 'disabled', ?)", now);
  db.run("INSERT INTO admin_users (id, name, token, role, created_at) VALUES (1, '会话管理员', ?, 'superadmin', ?)", ADMIN_TOKEN, now);
  const app = await buildApp({ db });
  t.after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

function login(app, orderCode) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orderCode } });
}

/** 从 set-cookie 里取出口令对（注入请求时要自己带上，inject 不会自动保存 cookie）。 */
function cookiePair(response) {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value).split(';')[0];
}

test('登录签发 HttpOnly 会话 cookie，响应体里不含票据', async (t) => {
  const { app } = await makeApp(t);
  const res = await login(app, USER_CODE);
  assert.equal(res.statusCode, 200);

  const raw = res.headers['set-cookie'];
  assert.ok(raw, '必须设置 set-cookie');
  assert.match(String(raw), /HttpOnly/);
  assert.match(String(raw), /SameSite=Lax/);
  assert.match(String(raw), /Path=\//);
  assert.match(String(raw), /Max-Age=\d+/);
  // 没有 HTTPS 之前不能带 Secure，否则浏览器直接丢弃（配置项默认 false）
  assert.doesNotMatch(String(raw), /Secure/);

  const sessionValue = cookiePair(res).split('=')[1];
  assert.ok(sessionValue.length > 20);
  assert.equal(res.body.includes(sessionValue), false, '票据不能出现在响应体里');
});

test('带会话 cookie 可以访问鉴权接口，且优先于 X-Order-Code', async (t) => {
  const { app } = await makeApp(t);
  const cookie = cookiePair(await login(app, USER_CODE));

  // 只带 cookie，不带任何下单码头
  const orders = await app.inject({ method: 'GET', url: '/api/v1/orders', headers: { cookie } });
  assert.equal(orders.statusCode, 200);
  assert.deepEqual(orders.json().orders, []);

  // cookie 属于用户 1，header 给个不存在的码：应以 cookie 身份为准，不报错
  const both = await app.inject({
    method: 'GET',
    url: '/api/v1/orders',
    headers: { cookie, 'x-order-code': 'nobody-else' },
  });
  assert.equal(both.statusCode, 200);
});

test('/auth/me：无会话 401，有会话返回身份，登出后立即失效', async (t) => {
  const { app } = await makeApp(t);

  const anonymous = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'SESSION_REQUIRED');

  const cookie = cookiePair(await login(app, USER_CODE));
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json().user, { id: 1, displayName: '会话用户', role: 'user' });

  const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
  assert.equal(logout.statusCode, 200);
  assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);

  const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  assert.equal(after.statusCode, 401);

  // 登出幂等
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } })).statusCode, 200);
});

test('管理员登录同样签发会话，并可用于管理端接口', async (t) => {
  const { app } = await makeApp(t);
  const res = await login(app, ADMIN_TOKEN);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.role, 'superadmin');

  const cookie = cookiePair(res);
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  assert.equal(me.json().user.role, 'superadmin');

  const specs = await app.inject({ method: 'GET', url: '/api/v1/admin/specs', headers: { cookie } });
  assert.equal(specs.statusCode, 200);
});

test('过期会话、停用账号都会被挡下', async (t) => {
  const { app, db } = await makeApp(t);

  // 会话过期
  const cookie = cookiePair(await login(app, USER_CODE));
  db.run("UPDATE user_sessions SET expires_at = '2020-01-01T00:00:00.000Z'");
  const expired = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  assert.equal(expired.statusCode, 401);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM user_sessions').n, 0, '过期会话应被清理');

  // 账号停用（会话还在）→ 403
  const cookie2 = cookiePair(await login(app, USER_CODE));
  db.run("UPDATE users SET status = 'disabled' WHERE id = 1");
  const disabled = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookie2 } });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.json().error.code, 'ORDER_CODE_DISABLED');
});

test('会话仓储：创建/查找/吊销/过期清理', () => {
  const db = createDb(':memory:');
  const { token } = createSession(db, { actorType: 'user', actorId: 1, ttlDays: 30 });
  assert.ok(findActiveSession(db, token));
  assert.equal(findActiveSession(db, 'short'), null, '垃圾串直接拒绝，不查库');

  // 吊销某个身份的全部会话
  createSession(db, { actorType: 'user', actorId: 1, ttlDays: 30 });
  createSession(db, { actorType: 'user', actorId: 2, ttlDays: 30 });
  assert.equal(deleteSessionsForActor(db, 'user', 1), 2);
  assert.equal(findActiveSession(db, token), null);

  // 过期清理
  db.run("UPDATE user_sessions SET expires_at = '2020-01-01T00:00:00.000Z'");
  assert.equal(purgeExpired(db), 1);
  db.close();
});

test('cookie 工具：解析、签发、清除', () => {
  assert.equal(readCookie({ headers: { cookie: 'a=1; jd_session=abc%20def; b=2' } }, 'jd_session'), 'abc def');
  assert.equal(readCookie({ headers: {} }, 'jd_session'), '');
  assert.equal(readCookie({ headers: { cookie: 'other=1' } }, 'jd_session'), '');

  const set = buildSessionCookie('jd_session', 'tok', { maxAgeSeconds: 3600, secure: true });
  assert.match(set, /^jd_session=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure$/);
  assert.match(buildClearedCookie('jd_session'), /Max-Age=0/);
});
