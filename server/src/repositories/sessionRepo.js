import { randomBytes } from 'node:crypto';

/**
 * 会话仓储：下单码校验通过后签发一枚随机票据，浏览器只拿到 HttpOnly cookie。
 * 票据不落前端，30 天滚动过期；登出、改码、账号删除都可即时吊销。
 */

const TOKEN_BYTES = 32;
/** 每次请求都写 last_seen_at 没必要，节流到这个间隔。 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export function createSession(db, { actorType, actorId, ttlDays = 30, now = () => new Date() }) {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + ttlDays * 24 * 3600 * 1000);
  db.run(
    `INSERT INTO user_sessions (token, actor_type, actor_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    token, actorType, actorId,
    createdAt.toISOString(), expiresAt.toISOString(), createdAt.toISOString(),
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

/** 取有效会话；过期即删除并返回 null。令牌长度先做粗筛，避免拿垃圾串查库。 */
export function findActiveSession(db, token, now = () => Date.now()) {
  if (typeof token !== 'string' || token.length < 24 || token.length > 200) return null;
  const row = db.get('SELECT * FROM user_sessions WHERE token = ?', token);
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now()) {
    deleteSession(db, token);
    return null;
  }
  return row;
}

export function touchSession(db, token, now = () => new Date()) {
  const row = db.get('SELECT last_seen_at FROM user_sessions WHERE token = ?', token);
  if (!row) return;
  if (now().getTime() - Date.parse(row.last_seen_at) < TOUCH_INTERVAL_MS) return;
  db.run('UPDATE user_sessions SET last_seen_at = ? WHERE token = ?', now().toISOString(), token);
}

export function deleteSession(db, token) {
  db.run('DELETE FROM user_sessions WHERE token = ?', token);
}

/** 吊销某个身份的全部会话（账号停用/删除时用）。 */
export function deleteSessionsForActor(db, actorType, actorId) {
  const info = db.run(
    'DELETE FROM user_sessions WHERE actor_type = ? AND actor_id = ?',
    actorType, actorId,
  );
  return info.changes ?? 0;
}

export function purgeExpired(db, now = () => new Date()) {
  const info = db.run('DELETE FROM user_sessions WHERE expires_at <= ?', now().toISOString());
  return info.changes ?? 0;
}
