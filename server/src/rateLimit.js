/**
 * 极简内存限流器（固定窗口）。
 *
 * 为什么不用 @fastify/rate-limit：本项目是单实例 systemd 部署，内存计数足够，
 * 不引入新依赖就不用担心离线安装和版本升级。进程重启计数清零 —— 可接受。
 *
 * 用法：
 *   const limiter = createRateLimit({ limit: 600, windowMs: 60_000 });
 *   const { allowed, retryAfterMs } = limiter.hit('user:12');
 */
export function createRateLimit({ limit, windowMs = 60_000, now = Date.now, maxKeys = 20_000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('createRateLimit 需要 limit 为正整数');
  }
  const buckets = new Map();

  /** 清掉过期桶，避免内存随访问者数量无界增长。 */
  function sweep(t) {
    for (const [key, bucket] of buckets) {
      if (t >= bucket.resetAt) buckets.delete(key);
    }
  }

  return {
    /**
     * 记一次访问。返回 { allowed, remaining, retryAfterMs }。
     * retryAfterMs 仅在 allowed=false 时有意义。
     */
    hit(key) {
      const t = now();
      if (buckets.size >= maxKeys) sweep(t);
      let bucket = buckets.get(key);
      if (!bucket || t >= bucket.resetAt) {
        bucket = { count: 0, resetAt: t + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (bucket.count > limit) {
        return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, bucket.resetAt - t) };
      }
      return { allowed: true, remaining: limit - bucket.count, retryAfterMs: 0 };
    },
    /** 主动解除某个 key 的限制（例如登录成功后重置失败计数）。 */
    clear(key) {
      buckets.delete(key);
    },
    /** 回收过期桶；用内部时钟，调用方不用关心参数。 */
    sweep() {
      sweep(now());
    },
    get size() {
      return buckets.size;
    },
  };
}

/**
 * 限流键：已带下单码的请求按「用户」区分（同一用户跨 IP 也算同一个人），
 * 未认证请求退化为按来源 IP。这样既防刷又不会把同一出口 IP 的多位用户互相牵连。
 */
export function rateLimitKey(request) {
  const raw = request.headers['x-order-code'];
  if (typeof raw === 'string' && raw.length > 0) {
    return `code:${raw.slice(0, 80)}`;
  }
  return `ip:${request.ip ?? request.socket?.remoteAddress ?? 'unknown'}`;
}
