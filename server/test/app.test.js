import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';

test('app: /api/v1/health 返回 ok，错误格式统一', async () => {
  const db = createDb(':memory:');
  const app = await buildApp({ db });

  const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });

  const missing = await app.inject({ method: 'GET', url: '/api/v1/nope' });
  assert.equal(missing.statusCode, 404);
  const body = missing.json();
  assert.equal(typeof body.error.code, 'string');
  assert.equal(typeof body.error.message, 'string');

  await app.close();
  db.close();
});
