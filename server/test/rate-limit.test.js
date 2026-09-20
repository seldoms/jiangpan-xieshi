import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { createRateLimit, rateLimitKey } from '../src/rateLimit.js';

test('限流器：窗口内超限后拒绝，窗口过后自动恢复', () => {
  let t = 1_000;
  const limiter = createRateLimit({ limit: 3, windowMs: 60_000, now: () => t });

  assert.deepEqual(
    [1, 2, 3].map(() => limiter.hit('k').allowed),
    [true, true, true],
  );
  const blocked = limiter.hit('k');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterMs > 0);

  // 不同 key 互不影响
  assert.equal(limiter.hit('other').allowed, true);

  // 窗口过后计数归零
  t += 60_001;
  assert.equal(limiter.hit('k').allowed, true);
});

test('限流器：clear 解除限制，sweep 回收过期桶', () => {
  let t = 0;
  const limiter = createRateLimit({ limit: 1, windowMs: 1_000, now: () => t });
  limiter.hit('a');
  limiter.hit('b');
  assert.equal(limiter.hit('a').allowed, false);

  limiter.clear('a');
  assert.equal(limiter.hit('a').allowed, true);

  t += 1_001;
  limiter.sweep();
  assert.equal(limiter.size, 0);
});

test('限流器：参数校验与内存上限', () => {
  assert.throws(() => createRateLimit({ limit: 0 }));
  assert.throws(() => createRateLimit({}));
  const limiter = createRateLimit({ limit: 10, windowMs: 1_000, maxKeys: 2 });
  limiter.hit('a');
  limiter.hit('b');
  limiter.hit('c'); // 触发一次回收
  assert.ok(limiter.size <= 3);
});

test('限流键：带下单码按用户，未带按下发请求的 IP', () => {
  assert.equal(rateLimitKey({ headers: { 'x-order-code': 'abc' }, ip: '1.2.3.4' }), 'code:abc');
  assert.equal(rateLimitKey({ headers: {}, ip: '1.2.3.4' }), 'ip:1.2.3.4');
});

async function makeApp(t, env) {
  const db = createDb(':memory:');
  const app = await buildApp({ db, env });
  t.after(async () => {
    await app.close();
    db.close();
  });
  return app;
}

test('限流生效时返回 429 + retry-after；健康检查不计入', async (t) => {
  const app = await makeApp(t, {
    LOG_LEVEL: 'silent',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_PER_MINUTE: '2',
    LOGIN_RATE_LIMIT_PER_MINUTE: '2',
  });

  const call = (url = '/api/v1/orders', headers = { 'x-order-code': 'nobody' }) =>
    app.inject({ method: 'GET', url, headers });

  assert.equal((await call()).statusCode, 401);
  assert.equal((await call()).statusCode, 401);
  const third = await call();
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().error.code, 'RATE_LIMITED');
  assert.ok(Number(third.headers['retry-after']) >= 1);

  // 健康检查豁免，不受限流影响
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode, 200);
  }
});

test('限流默认在测试环境关闭，不会打红其它用例', async (t) => {
  // 不传 env：走 process.env，node --test 注入的 NODE_TEST_CONTEXT 让限流自动关闭
  const db = createDb(':memory:');
  const app = await buildApp({ db });
  t.after(async () => {
    await app.close();
    db.close();
  });
  assert.equal(app.config.rateLimitEnabled, false);
  for (let i = 0; i < 25; i += 1) {
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders', headers: { 'x-order-code': 'nobody' } });
    assert.equal(res.statusCode, 401, `第 ${i + 1} 次不应被限流`);
  }
});
