import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { autoSortSpecs, createSpec, listSpecs } from '../src/repositories/configRepo.js';

// 本文件独占：spec-sort.test.js
// 覆盖「规格展示顺序」这一条链路（顺序直接决定前台价目表的展示次序）：
//   ① 新建规格不再由前端写死 sort=9999，后端自动排到末位
//   ② POST /admin/specs/auto-sort 一键按「公母分组 + 重量升序」归位
//   ③ 拖拽用的 PUT /admin/specs/reorder 仍然有效（回归）

const ADMIN_HEADERS = { authorization: 'Bearer dev-admin-token' };

async function makeApp(t) {
  const db = createDb(':memory:');
  const app = await buildApp({ db, env: {} });
  t.after(async () => { await app.close(); db.close(); });
  return { app, db };
}

function insertSpec(db, { gender = 'male', weightLabel = '4两', priceCents = 2500, sort = 0 } = {}) {
  return Number(db.run(
    'INSERT INTO specs (batch_id, gender, weight_label, price_cents, active, sold_out, sort) VALUES (NULL, ?, ?, ?, 1, 0, ?)',
    gender, weightLabel, priceCents, sort,
  ).lastInsertRowid);
}

const order = (db) => listSpecs(db).map((spec) => `${spec.gender}:${spec.weightLabel}`);

test('新建规格：不传 sort 时排到末位（空表从 0 开始，不是写死的 9999）', () => {
  const db = createDb(':memory:');
  const first = createSpec(db, { gender: 'male', weightLabel: '4两', priceCents: 2500 });
  assert.equal(first.sort, 0, '第一条规格 sort 应为 0');
  const second = createSpec(db, { gender: 'female', weightLabel: '3两', priceCents: 3000 });
  assert.equal(second.sort, 1, '新规格应接在已有最大 sort 之后');
  db.close();
});

test('新建规格：显式传入 sort 时仍然以传入值为准（保留原有的可指定语义）', () => {
  const db = createDb(':memory:');
  insertSpec(db, { sort: 5 });
  const spec = createSpec(db, { gender: 'female', weightLabel: '3.5两', priceCents: 3800, sort: 2 });
  assert.equal(spec.sort, 2);
  db.close();
});

test('auto-sort：按「公母分组 + 价格降序」重排，高品质（贵）的排到最前', () => {
  const db = createDb(':memory:');
  // 刻意按线上那套乱序插入：公蟹 4 / 3.5，母蟹 3.5 / 3，后三个是 9999 的新增规格
  insertSpec(db, { gender: 'male', weightLabel: '4两', priceCents: 2500, sort: 1 });
  insertSpec(db, { gender: 'male', weightLabel: '3.5两', priceCents: 2000, sort: 2 });
  insertSpec(db, { gender: 'female', weightLabel: '3.5两', priceCents: 3800, sort: 3 });
  insertSpec(db, { gender: 'female', weightLabel: '3两', priceCents: 3000, sort: 4 });
  insertSpec(db, { gender: 'male', weightLabel: '4.5两', priceCents: 3300, sort: 9999 });
  insertSpec(db, { gender: 'male', weightLabel: '5两', priceCents: 4300, sort: 9999 });
  insertSpec(db, { gender: 'female', weightLabel: '4两', priceCents: 4600, sort: 9999 });

  const sorted = autoSortSpecs(db);

  assert.deepEqual(
    sorted.map((spec) => `${spec.gender}:${spec.weightLabel}`),
    ['male:5两', 'male:4.5两', 'male:4两', 'male:3.5两', 'female:4两', 'female:3.5两', 'female:3两'],
    '公蟹在前、母蟹在后，各组内按价格从高到低',
  );
  assert.deepEqual(sorted.map((spec) => spec.sort), [0, 1, 2, 3, 4, 5, 6], 'sort 写回连续值');
  assert.deepEqual(order(db), sorted.map((spec) => `${spec.gender}:${spec.weightLabel}`), '落库顺序与返回一致');
  db.close();
});

test('auto-sort：同价按 id 稳定排序，重复执行结果稳定（幂等）', () => {
  const db = createDb(':memory:');
  insertSpec(db, { gender: 'male', weightLabel: '大号', priceCents: 2500, sort: 0 });   // 与下一条同价，id 更小
  insertSpec(db, { gender: 'male', weightLabel: '4两', priceCents: 2500, sort: 1 });
  insertSpec(db, { gender: 'male', weightLabel: '5两', priceCents: 4300, sort: 2 });
  insertSpec(db, { gender: 'female', weightLabel: '3两', priceCents: 3000, sort: 3 });

  const once = autoSortSpecs(db).map((spec) => `${spec.gender}:${spec.weightLabel}`);
  assert.deepEqual(once, ['male:5两', 'male:大号', 'male:4两', 'female:3两'], '价格高的在前，同价按 id 稳定');
  const twice = autoSortSpecs(db).map((spec) => `${spec.gender}:${spec.weightLabel}`);
  assert.deepEqual(twice, once, '重复执行结果稳定（幂等）');
  db.close();
});

test('HTTP：POST /admin/specs 不传 sort 排末位，auto-sort 与 reorder 均可生效', async (t) => {
  const { app, db } = await makeApp(t);
  const post = (url, payload) => app.inject({ method: 'POST', url, headers: ADMIN_HEADERS, payload });

  assert.equal((await post('/api/v1/admin/specs', { gender: 'male', weightLabel: '4两', priceCents: 2500 })).statusCode, 201);
  const createdBeside = await post('/api/v1/admin/specs', { gender: 'female', weightLabel: '3两', priceCents: 3000 });
  assert.equal(createdBeside.statusCode, 201);
  assert.equal(createdBeside.json().spec.sort, 1, '新增规格自动排末位');
  await post('/api/v1/admin/specs', { gender: 'male', weightLabel: '3.5两', priceCents: 2000 });

  const auto = await post('/api/v1/admin/specs/auto-sort', {});
  assert.equal(auto.statusCode, 200);
  assert.deepEqual(
    auto.json().specs.map((spec) => `${spec.gender}:${spec.weightLabel}`),
    ['male:4两', 'male:3.5两', 'female:3两'],
    '按价格降序：公蟹 25 元在前、20 元在后；母蟹 30 元独立成组',
  );

  // reorder 回归：拖拽保存仍按传入 ids 定序
  const ids = auto.json().specs.map((spec) => spec.id).reverse();
  const reordered = await app.inject({
    method: 'PUT', url: '/api/v1/admin/specs/reorder', headers: ADMIN_HEADERS, payload: { ids },
  });
  assert.equal(reordered.statusCode, 200);
  assert.deepEqual(reordered.json().specs.map((spec) => spec.id), ids, '拖拽顺序按传入 ids 落库');
});

test('HTTP：auto-sort 需要管理员，匿名调用 401', async (t) => {
  const { app } = await makeApp(t);
  const res = await app.inject({ method: 'POST', url: '/api/v1/admin/specs/auto-sort', payload: {} });
  assert.equal(res.statusCode, 401);
});
