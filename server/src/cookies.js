/**
 * Cookie 读写（零依赖）。
 *
 * 只解析一个具名 cookie：下单码换来的会话票据。
 * HttpOnly + SameSite=Lax 由服务端签发时写入，前端 JS 读不到，XSS 偷不走。
 */

export function readCookie(request, name) {
  const header = request.headers?.cookie;
  if (!header || typeof header !== 'string') return '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

export function buildSessionCookie(name, token, { maxAgeSeconds, secure = false }) {
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  // ⚠️ 站点还是 http:// 时绝不能带 Secure，否则浏览器直接丢弃这条 cookie，所有人都登不上。
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearedCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
