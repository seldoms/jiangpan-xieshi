import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createRateLimit, rateLimitKey } from './rateLimit.js';
import configRoutes from './routes/config.js';
import orderRoutes from './routes/orders.js';
import cartRoutes from './routes/cart.js';
import groupRoutes from './routes/groups.js';
import fulfillmentRoutes from './routes/fulfillment.js';
import userRoutes from './routes/users.js';
import { ensureDailyBatch } from './repositories/dailyBatchRepo.js';

/**
 * 应用工厂：创建 Fastify 实例、打开数据库并跑迁移、注册基础钩子。
 * 后续业务路由通过 buildApp({ db }) 注入或 app.db 访问 DAO 层。
 */
export async function buildApp(opts = {}) {
  const config = loadConfig(opts.env ?? process.env);
  const db = opts.db ?? createDb(opts.databasePath ?? config.databasePath);
  const ownsDb = !opts.db;

  // 日志：测试静默（logLevel=silent → logger:false）；生产输出 JSON 结构化日志，
  // systemd journald 可直读。访问日志只记 method/url/状态/耗时，不打请求体与下单码头。
  const app = Fastify({ logger: config.logLevel === 'silent' ? false : { level: config.logLevel } });
  app.decorate('db', db);
  app.decorate('config', config);

  // 限流：登录接口单独一档更严（防下单码枚举），其余请求按用户/来源 IP 计。
  const limiter = createRateLimit({ limit: config.rateLimitPerMinute });
  const loginLimiter = createRateLimit({ limit: config.loginRateLimitPerMinute });
  const limiterSweep = setInterval(() => {
    limiter.sweep();
    loginLimiter.sweep();
  }, 60_000);
  limiterSweep.unref();

  app.addHook('onRequest', async (request, reply) => {
    if (!config.rateLimitEnabled) return;
    const path = request.url.split('?')[0];
    if (path === '/api/v1/health') return;
    const key = rateLimitKey(request);
    const bucket = request.method === 'POST' && path === '/api/v1/auth/login' ? loginLimiter : limiter;
    const { allowed, retryAfterMs } = bucket.hit(key);
    if (allowed) return;
    reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)));
    const err = new Error('操作过于频繁，请稍后再试');
    err.statusCode = 429;
    err.code = 'RATE_LIMITED';
    throw err;
  });

  app.addHook('onRequest', async () => { ensureDailyBatch(db); });
  // 无人访问也按时发布；请求钩子消除定时器间隔及进程重启的空窗。
  const dailyBatchTimer = setInterval(() => {
    try { ensureDailyBatch(db); } catch (error) { app.log.error({ err: error }, 'daily batch rollover failed'); }
  }, 15_000);
  dailyBatchTimer.unref();

  app.addHook('onResponse', (req, reply, done) => {
    req.log.info({
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      ms: Number(reply.elapsedTime.toFixed(1)),
    }, 'request');
    done();
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `route ${req.method} ${req.url} not found` } });
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    // 5xx 打全量堆栈；4xx 只记一行，避免把客户端错误刷成噪声。
    if (status >= 500) req.log.error({ err }, 'request failed');
    else req.log.warn({ statusCode: status, code: err.code, url: req.url }, 'request rejected');
    reply.code(status).send({
      error: {
        code: err.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
        message: status >= 500 ? 'internal server error' : err.message,
      },
    });
  });

  app.addHook('onClose', async () => {
    clearInterval(dailyBatchTimer);
    clearInterval(limiterSweep);
    if (ownsDb) db.close();
  });

  app.get('/api/v1/health', async () => ({ ok: true }));

  await app.register(configRoutes);
  await app.register(orderRoutes);
  await app.register(cartRoutes);
  await app.register(groupRoutes);
  await app.register(fulfillmentRoutes);
  await app.register(userRoutes);

  return app;
}
