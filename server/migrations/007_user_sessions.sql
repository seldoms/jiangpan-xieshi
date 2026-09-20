-- 下单码换 HttpOnly 会话票据：浏览器不再长期保存下单码，服务端可过期、可吊销。
-- 与 users / orders / groups 的软删除无关，登出即物理删除该行。
CREATE TABLE IF NOT EXISTS user_sessions (
  token TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'admin')),
  actor_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_actor ON user_sessions(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
