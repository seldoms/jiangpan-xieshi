import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';

const ADMIN_HEADERS = { authorization: 'Bearer dev-admin-token' };

test('production config: 未注入强管理员令牌时拒绝启动', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production' }),
    /ADMIN_TOKEN/,
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', ADMIN_TOKEN: 'too-short' }),
    /至少 16 个字符/,
  );
  assert.equal(
    loadConfig({ NODE_ENV: 'production', ADMIN_TOKEN: '0123456789abcdef' }).adminToken,
    '0123456789abcdef',
  );
});

async function makeApp() {
  const db = createDb(':memory:');
  const app = await buildApp({ db, env: {} });
  return { app, db };
}

function insertUser(db, { orderCode, displayName, status = 'active' }) {
  const result = db.run(
    'INSERT INTO users (order_code, display_name, status, created_at) VALUES (?, ?, ?, ?)',
    orderCode, displayName, status, new Date().toISOString(),
  );
  return result.lastInsertRowid;
}

function insertBatch(db, { name, cutoffTime, status = 'open' }) {
  const result = db.run(
    'INSERT INTO batches (name, cutoff_time, status, created_at) VALUES (?, ?, ?, ?)',
    name, cutoffTime, status, new Date().toISOString(),
  );
  return Number(result.lastInsertRowid);
}

function insertSpec(db, { batchId = null, gender, weightLabel, priceCents, active = 1, sort = 0 }) {
  const result = db.run(
    'INSERT INTO specs (batch_id, gender, weight_label, price_cents, active, sort) VALUES (?, ?, ?, ?, ?, ?)',
    batchId, gender, weightLabel, priceCents, active, sort,
  );
  return Number(result.lastInsertRowid);
}

test('auth: 下单码登录成功返回用户基本信息', async () => {
  const { app, db } = await makeApp();
  const userId = insertUser(db, { orderCode: '测试用户a1b2', displayName: '测试用户' });

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { orderCode: '测试用户a1b2' },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { user: { id: userId, displayName: '测试用户', role: 'user' } });

  await app.close();
  db.close();
});

test('auth: 浏览器 URL 编码中文下单码可通过用户接口鉴权', async () => {
  const { app, db } = await makeApp();
  insertUser(db, { orderCode: '测试用户a1b2', displayName: '测试用户' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/orders',
    headers: { 'x-order-code': encodeURIComponent('测试用户a1b2') },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { orders: [] });
  await app.close();
  db.close();
});

test('auth: 新下单码自动建立用户，非法格式 400，停用返回 403，缺码返回 400', async () => {
  const { app, db } = await makeApp();
  insertUser(db, { orderCode: '停用用户c3d4', displayName: '停用用户', status: 'disabled' });

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { orderCode: '新用户A1' },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().user.displayName, '新用户');

  const invalid = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { orderCode: '新用户 A1' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'ORDER_CODE_INVALID_FORMAT');

  const disabled = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { orderCode: '停用用户c3d4' },
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.json().error.code, 'ORDER_CODE_DISABLED');

  const empty = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {},
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error.code, 'ORDER_CODE_REQUIRED');

  await app.close();
  db.close();
});

test('specs: 管理端规格 CRUD 与启停', async () => {
  const { app, db } = await makeApp();

  const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/admin/specs' });
  assert.equal(unauthorized.statusCode, 401);

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/specs',
    headers: ADMIN_HEADERS,
    payload: { gender: 'male', weightLabel: '4两', priceCents: 8800, sort: 1 },
  });
  assert.equal(created.statusCode, 201);
  const spec = created.json().spec;
  assert.equal(spec.gender, 'male');
  assert.equal(spec.weightLabel, '4两');
  assert.equal(spec.priceCents, 8800);
  assert.equal(spec.active, true);

  const invalidPrice = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/specs',
    headers: ADMIN_HEADERS,
    payload: { gender: 'male', weightLabel: '4两', priceCents: 88.5 },
  });
  assert.equal(invalidPrice.statusCode, 422);

  const invalidGender = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/specs',
    headers: ADMIN_HEADERS,
    payload: { gender: 'other', weightLabel: '4两', priceCents: 8800 },
  });
  assert.equal(invalidGender.statusCode, 422);

  const updated = await app.inject({
    method: 'PUT',
    url: `/api/v1/admin/specs/${spec.id}`,
    headers: ADMIN_HEADERS,
    payload: { priceCents: 9800, active: false },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().spec.priceCents, 9800);
  assert.equal(updated.json().spec.active, false);

  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/specs',
    headers: ADMIN_HEADERS,
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().specs.length, 1);
  assert.equal(list.json().specs[0].priceCents, 9800);

  const notFound = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/specs/999',
    headers: ADMIN_HEADERS,
    payload: { priceCents: 1 },
  });
  assert.equal(notFound.statusCode, 404);

  await app.close();
  db.close();
});

test('package-templates: 合计不等于 10 只被拒（422），合法模板可增改停启', async () => {
  const { app, db } = await makeApp();
  const male = insertSpec(db, { gender: 'male', weightLabel: '4两', priceCents: 8800 });
  const female = insertSpec(db, { gender: 'female', weightLabel: '3两', priceCents: 7800 });

  const sum9 = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/package-templates',
    headers: ADMIN_HEADERS,
    payload: {
      name: '缺一只',
      packaging: 'gift',
      items: [
        { specId: male, quantity: 5 },
        { specId: female, quantity: 4 },
      ],
    },
  });
  assert.equal(sum9.statusCode, 422);
  assert.equal(sum9.json().error.code, 'PACKAGE_TOTAL_INVALID');

  const unknownSpec = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/package-templates',
    headers: ADMIN_HEADERS,
    payload: { name: '坏规格', packaging: 'plain', items: [{ specId: 999, quantity: 10 }] },
  });
  assert.equal(unknownSpec.statusCode, 422);

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/package-templates',
    headers: ADMIN_HEADERS,
    payload: {
      name: '5公5母',
      packaging: 'gift',
      items: [
        { specId: male, quantity: 5 },
        { specId: female, quantity: 5 },
      ],
    },
  });
  assert.equal(created.statusCode, 201);
  const template = created.json().template;
  assert.equal(template.totalCount, 10);
  assert.equal(template.items.length, 2);
  assert.equal(template.crabCentsPerCopy, 5 * 8800 + 5 * 7800);

  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/package-templates',
    headers: ADMIN_HEADERS,
  });
  assert.equal(list.json().templates.length, 1);
  assert.equal(list.json().templates[0].items.length, 2);

  const updated = await app.inject({
    method: 'PUT',
    url: `/api/v1/admin/package-templates/${template.id}`,
    headers: ADMIN_HEADERS,
    payload: { name: '全公', items: [{ specId: male, quantity: 10 }] },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().template.name, '全公');
  assert.equal(updated.json().template.totalCount, 10);
  assert.equal(updated.json().template.items.length, 1);

  const badUpdate = await app.inject({
    method: 'PUT',
    url: `/api/v1/admin/package-templates/${template.id}`,
    headers: ADMIN_HEADERS,
    payload: { items: [{ specId: male, quantity: 11 }] },
  });
  assert.equal(badUpdate.statusCode, 422);

  const toggledOff = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/package-templates/${template.id}/toggle`,
    headers: ADMIN_HEADERS,
  });
  assert.equal(toggledOff.json().template.active, false);
  const toggledOn = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/package-templates/${template.id}/toggle`,
    headers: ADMIN_HEADERS,
  });
  assert.equal(toggledOn.json().template.active, true);

  await app.close();
  db.close();
});

test('batches: 创建、列表、关闭', async () => {
  const { app, db } = await makeApp();

  // 截单时间必须晚于「当前时刻」，这里一律用相对时间：写死日期会让用例随系统时钟过期
  // （2026-09-20 22:00 实测踩过：写死的 2026-09-20T09:00Z 过期后返回 422 CUTOFF_TIME_INVALID，全量 177/1）。
  const cutoffAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const cutoffTime = cutoffAt.toISOString();
  const nextDayCutoff = new Date(cutoffAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const batchName = `自动化批次${cutoffTime.slice(0, 10)}`;

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/batches',
    headers: ADMIN_HEADERS,
    payload: { name: batchName, cutoffTime },
  });
  assert.equal(created.statusCode, 201);
  const batch = created.json().batch;
  assert.equal(batch.status, 'open');
  assert.equal(batch.cutoffTime, cutoffTime);

  const badCutoff = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/batches',
    headers: ADMIN_HEADERS,
    payload: { name: '坏批次', cutoffTime: 'not-a-date' },
  });
  assert.equal(badCutoff.statusCode, 422);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/batches',
    headers: ADMIN_HEADERS,
    payload: { name: batchName, cutoffTime: nextDayCutoff },
  });
  assert.equal(duplicate.statusCode, 409);

  const closed = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/batches/${batch.id}/close`,
    headers: ADMIN_HEADERS,
  });
  assert.equal(closed.statusCode, 200);
  assert.equal(closed.json().batch.status, 'closed');

  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/batches',
    headers: ADMIN_HEADERS,
  });
  assert.equal(list.json().batches.length, 2);
  assert.equal(list.json().batches[0].status, 'open');
  assert.equal(list.json().batches[1].status, 'closed');

  const closeMissing = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/batches/999/close',
    headers: ADMIN_HEADERS,
  });
  assert.equal(closeMissing.statusCode, 404);

  await app.close();
  db.close();
});

test('settings: 读写包装价格，非整数分被拒', async () => {
  const { app, db } = await makeApp();

  const empty = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/settings',
    headers: ADMIN_HEADERS,
  });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json().settings, {});

  const updated = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/settings',
    headers: ADMIN_HEADERS,
    payload: { 'packaging.plain': 0, 'packaging.gift': 1000 },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().settings['packaging.gift'], 1000);

  const changed = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/settings',
    headers: ADMIN_HEADERS,
    payload: { 'packaging.gift': 1500 },
  });
  assert.equal(changed.json().settings['packaging.gift'], 1500);
  assert.equal(changed.json().settings['packaging.plain'], 0);

  const nonInteger = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/settings',
    headers: ADMIN_HEADERS,
    payload: { 'packaging.gift': 'abc' },
  });
  assert.equal(nonInteger.statusCode, 422);

  await app.close();
  db.close();
});

test('settings: 分享站点校验并公开返回，允许清除且无批次也可读取', async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  const config = async () => (await app.inject({ method: 'GET', url: '/api/v1/config/current' })).json();
  const save = (value, headers = ADMIN_HEADERS) => app.inject({
    method: 'PUT', url: '/api/v1/admin/settings', headers, payload: { 'share.site_url': value },
  });
  assert.equal((await config()).shareBaseUrl, '');
  assert.equal((await save('https://crab.example.com', {})).statusCode, 401);
  for (const value of ['https://crab.example.com/', 'http://192.168.1.20:7648']) {
    const response = await save(value);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await config()).shareBaseUrl, new URL(value).origin);
  }
  for (const value of [null, 7648, 'abc', 'javascript:alert(1)', 'ftp://crab.example.com', 'https://user:pass@crab.example.com', 'https://@crab.example.com', 'https://crab.example.com/path', 'https://crab.example.com/./', 'https://crab.example.com?group=secret', 'https://crab.example.com?', 'https://crab.example.com#', ' https://crab.example.com', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://2130706433', 'http://[::1]:5173', 'http://0.0.0.0:5173']) {
    const response = await save(value);
    assert.equal(response.statusCode, 422, `${value}: ${response.body}`);
    assert.equal((await config()).shareBaseUrl, 'http://192.168.1.20:7648');
  }
  insertBatch(db, { name: '分享测试', cutoffTime: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal((await config()).shareBaseUrl, 'http://192.168.1.20:7648');
  assert.equal((await save('')).statusCode, 200);
  assert.equal((await config()).shareBaseUrl, '');
});

test('config/current: 返回当前批次、截单状态、规格、套餐和包装价格', async () => {
  const { app, db } = await makeApp();
  const futureCutoff = new Date(Date.now() + 3600_000).toISOString();
  const batchId = insertBatch(db, { name: '当前批次', cutoffTime: futureCutoff });
  const male = insertSpec(db, { batchId, gender: 'male', weightLabel: '4两', priceCents: 8800, sort: 1 });
  const female = insertSpec(db, { batchId, gender: 'female', weightLabel: '3两', priceCents: 7800, sort: 2 });
  insertSpec(db, { batchId, gender: 'male', weightLabel: '3两', priceCents: 5800, active: 0, sort: 3 });
  db.run(
    "INSERT INTO package_templates (id, name, packaging, active, created_at) VALUES (1, '5公5母', 'gift', 1, ?)",
    new Date().toISOString(),
  );
  db.run('INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (1, ?, ?)', male, 5);
  db.run('INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (1, ?, ?)', female, 5);
  db.run("INSERT INTO settings (key, value) VALUES ('packaging.gift', '1000')");

  const res = await app.inject({ method: 'GET', url: '/api/v1/config/current' });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.batch.id, batchId);
  assert.equal(body.batch.cutoffTime, futureCutoff);
  assert.equal(body.batch.isAfterCutoff, false);

  assert.equal(body.specs.length, 2);
  assert.deepEqual(
    body.specs.map((s) => [s.gender, s.weightLabel, s.priceCents]),
    [['male', '4两', 8800], ['female', '3两', 7800]],
  );

  assert.equal(body.templates.length, 1);
  assert.equal(body.templates[0].totalCount, 10);
  assert.equal(body.templates[0].items.length, 2);

  assert.deepEqual(body.packagingPrices, { plain: 0, gift: 1000 });

  await app.close();
  db.close();
});

test('config/current: 已过截单时间自动发布下一批次；从未发布时返回空结构', async () => {
  const { app, db } = await makeApp();
  const empty = (await app.inject({ method: 'GET', url: '/api/v1/config/current' })).json();
  assert.equal(empty.batch, null);
  assert.deepEqual(empty.specs, []);
  const pastCutoff = new Date(Date.now() - 3600_000).toISOString();
  insertBatch(db, { name: '已截单批次', cutoffTime: pastCutoff });
  const res = await app.inject({ method: 'GET', url: '/api/v1/config/current' });
  assert.equal(res.json().batch.isAfterCutoff, false);
  assert.equal(res.json().batch.id, 2);
  assert.equal(new Date(res.json().batch.cutoffTime) - new Date(pastCutoff), 86_400_000);
  assert.equal(db.get('SELECT status FROM batches WHERE id = 1').status, 'closed');
  await app.close();
  db.close();
});
