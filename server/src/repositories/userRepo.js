import { httpError, insertAudit } from './fulfillmentRepo.js';

// 后台用户管理：只列活跃（未软删）用户，附带下单统计；金额为整数分。
export function listUsersWithStats(db) {
  return db.all(
    `SELECT u.id, u.order_code, u.display_name, u.created_at, u.last_login_at,
            COUNT(o.id) AS order_count,
            COALESCE(SUM(COALESCE(o.total_cents, o.crab_cents + o.packaging_cents)), 0) AS spend_cents,
            MAX(o.created_at) AS last_order_at
     FROM users u
     LEFT JOIN orders o ON o.user_id = u.id AND o.deleted_at IS NULL
     WHERE u.deleted_at IS NULL
     GROUP BY u.id
     ORDER BY MAX(o.created_at) DESC, u.created_at DESC`,
  );
}

/**
 * 软删除用户：账号标记 deleted_at，其全部未删订单一并软删（所有列表/汇总
 * 已经按 orders.deleted_at IS NULL 过滤，页面立即消失），购物车草稿清除。
 * 团长名下的拼团保留：拼团链接是成员共享数据，不随团长删除。
 */
export function softDeleteUser(db, userId, actor) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw httpError(404, 'USER_NOT_FOUND', '用户不存在');
  if (user.deleted_at) throw httpError(409, 'USER_ALREADY_DELETED', '该用户已被删除');
  const now = new Date().toISOString();
  db.tx(() => {
    db.run('UPDATE users SET deleted_at = ? WHERE id = ?', now, userId);
    const orders = db.run(
      'UPDATE orders SET deleted_at = ? WHERE user_id = ? AND deleted_at IS NULL',
      now,
      userId,
    );
    db.run('DELETE FROM cart_drafts WHERE user_id = ?', userId);
    insertAudit(db, {
      actorType: 'admin',
      actorId: actor.id,
      action: 'user.delete',
      entity: 'user',
      entityId: userId,
      detail: `删除用户「${user.display_name}」（${user.order_code}），同时软删订单 ${orders.changes} 张`,
    });
  })();
  return user;
}

export function touchLastLogin(db, userId) {
  db.run('UPDATE users SET last_login_at = ? WHERE id = ?', new Date().toISOString(), userId);
}
