import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export const TIMEZONE = 'Asia/Shanghai';

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  // node --test 会在子进程里设置 NODE_TEST_CONTEXT；用它自动关掉限流与日志，
  // 否则 100+ 个用例共享同一个来源 IP 会被自己的限流打红。
  const isTest = Boolean(env.NODE_TEST_CONTEXT) || nodeEnv === 'test';
  const adminToken = env.ADMIN_TOKEN ?? (nodeEnv === 'production' ? '' : 'dev-admin-token');
  if (nodeEnv === 'production' && adminToken.length < 16) {
    throw new Error('生产环境必须通过 ADMIN_TOKEN 注入至少 16 个字符的管理员令牌');
  }
  return {
    port: Number(env.PORT ?? 3001),
    host: env.HOST ?? '0.0.0.0',
    databasePath: env.DATABASE_PATH ?? path.join(SERVER_ROOT, 'data', 'app.db'),
    adminToken,
    timezone: TIMEZONE,
    nodeEnv,
    isTest,
    // 日志：测试静默；生产输出 JSON 结构化日志（journald 可直读）。
    logLevel: env.LOG_LEVEL ?? (isTest ? 'silent' : 'info'),
    // 限流：默认开（测试除外）；登录接口单独一档更严，防下单码枚举。
    rateLimitEnabled: env.RATE_LIMIT_ENABLED ? env.RATE_LIMIT_ENABLED !== 'false' : !isTest,
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 600),
    loginRateLimitPerMinute: Number(env.LOGIN_RATE_LIMIT_PER_MINUTE ?? 30),
    // 会话：下单码换 HttpOnly 会话票据，30 天滚动过期。
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    // ⚠️ 没有 HTTPS 之前必须保持 false：带 Secure 的 cookie 在 http:// 下会被浏览器丢弃，
    // 直接导致所有人登录不上。对外挂上 HTTPS 后再设 SESSION_COOKIE_SECURE=true。
    sessionCookieSecure: env.SESSION_COOKIE_SECURE === 'true',
    sessionCookieName: env.SESSION_COOKIE_NAME ?? 'jd_session',
  };
}
