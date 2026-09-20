import { normalizeOrderCode, validateOrderCode } from '../orderCode.js';
import { readCookie } from '../cookies.js';
import { findActiveSession, touchSession } from '../repositories/sessionRepo.js';

/**
 * 鉴权助手：路由内直接调用，统一鉴权口径。
 *
 * 两种凭据，会话优先：
 * 1. **HttpOnly 会话 cookie**（首选）：`POST /api/v1/auth/login` 校验下单码后签发，
 *    浏览器 JS 读不到，XSS 偷不走，服务端可过期/吊销。
 * 2. **X-Order-Code 头**（兼容保留）：迁移期与拼团页团长临时身份仍在使用。
 *
 * requireAdmin(request)：同样的两种凭据，命中 admin_users 后按 role 授权，
 * 另外兼容 `Authorization: Bearer <ADMIN_TOKEN>`。权限一律不采信客户端自报。
 *
 * 用法：const user = requireUser(request); / const admin = requireAdmin(request);
 * 抛出的 Error 带 statusCode 和 code，由全局错误处理器统一输出 {error:{code,message}}。
 */

function unauthorized(code, message) {
  const err = new Error(message);
  err.statusCode = 401;
  err.code = code;
  return err;
}

function forbidden(code, message) {
  const err = new Error(message);
  err.statusCode = 403;
  err.code = code;
  return err;
}

/** 生效中的会话行（仅 cookie），没有则 null。 */
export function currentSession(request) {
  const name = request.server.config?.sessionCookieName ?? 'jd_session';
  const token = readCookie(request, name);
  if (!token) return null;
  const session = findActiveSession(request.server.db, token);
  if (!session) return null;
  touchSession(request.server.db, token);
  return session;
}

function assertUserUsable(user) {
  if (user.deleted_at) throw forbidden('ORDER_CODE_DELETED', '该账号已被删除，请联系管理员');
  if (user.status !== 'active') throw forbidden('ORDER_CODE_DISABLED', '下单码已停用，请联系管理员');
  return user;
}

function userFromOrderCodeHeader(request) {
  const encodedCode = request.headers['x-order-code'];
  if (!encodedCode || typeof encodedCode !== 'string') {
    throw unauthorized('ORDER_CODE_REQUIRED', '缺少下单码');
  }
  let code;
  try {
    // 兼容旧客户端的原文 ASCII/Node 注入请求，同时支持浏览器传来的 URL 编码中文。
    code = decodeURIComponent(encodedCode);
  } catch {
    throw unauthorized('ORDER_CODE_INVALID', '下单码无效');
  }
  code = normalizeOrderCode(code);
  if (validateOrderCode(code)) throw unauthorized('ORDER_CODE_INVALID', '下单码格式无效');
  const user = request.server.db.get(
    'SELECT * FROM users WHERE order_code = ? COLLATE NOCASE',
    code,
  );
  if (!user) throw unauthorized('ORDER_CODE_INVALID', '下单码无效');
  return assertUserUsable(user);
}

export function requireUser(request) {
  const session = currentSession(request);
  if (session && session.actor_type === 'user') {
    const user = request.server.db.get('SELECT * FROM users WHERE id = ?', session.actor_id);
    if (user) return assertUserUsable(user);
    // 会话指向的账号已被物理删除：当作未登录，别把无效票据当身份用。
  }
  return userFromOrderCodeHeader(request);
}

function adminFromOrderCode(request, encodedCode) {
  let code;
  try {
    if (typeof encodedCode !== 'string') throw new Error('invalid code');
    code = normalizeOrderCode(decodeURIComponent(encodedCode));
  } catch {
    throw unauthorized('ORDER_CODE_INVALID', '下单码无效');
  }
  if (validateOrderCode(code)) throw unauthorized('ORDER_CODE_INVALID', '下单码格式无效');
  const admin = findAdminByOrderCode(request.server.db, code);
  if (!admin) throw unauthorized('ADMIN_CODE_INVALID', '管理员下单码无效');
  return requireAdminRole(admin);
}

export function requireAdmin(request) {
  const session = currentSession(request);
  if (session && session.actor_type === 'admin') {
    const admin = request.server.db.get('SELECT * FROM admin_users WHERE id = ?', session.actor_id);
    if (admin) return requireAdminRole(admin);
  }
  const encodedCode = request.headers['x-order-code'];
  if (encodedCode !== undefined) return adminFromOrderCode(request, encodedCode);
  const header = request.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw unauthorized('ADMIN_TOKEN_REQUIRED', '缺少管理员令牌');
  if (token === request.server.config.adminToken) {
    return { id: 0, name: 'env-admin', role: 'admin' };
  }
  const admin = request.server.db.get(
    'SELECT * FROM admin_users WHERE token = ?',
    token,
  );
  if (!admin) throw unauthorized('ADMIN_TOKEN_INVALID', '管理员令牌无效');
  return requireAdminRole(admin);
}

export function findAdminByOrderCode(db, code) {
  return db.get('SELECT * FROM admin_users WHERE token = ? COLLATE NOCASE', normalizeOrderCode(code));
}

export function requireAdminRole(admin) {
  if (!['admin', 'superadmin'].includes(admin.role)) {
    throw forbidden('ADMIN_ROLE_FORBIDDEN', '此账号没有管理权限');
  }
  return admin;
}
