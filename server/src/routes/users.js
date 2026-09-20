import { requireAdmin } from '../plugins/auth.js';
import * as userRepo from '../repositories/userRepo.js';
import { httpError } from '../repositories/fulfillmentRepo.js';

/** 后台用户管理：列表（带下单统计）与软删除。 */
export default async function userRoutes(app) {
  app.get('/api/v1/admin/users', async (request) => {
    requireAdmin(request);
    const rows = userRepo.listUsersWithStats(request.server.db);
    return {
      users: rows.map((row) => ({
        id: row.id,
        orderCode: row.order_code,
        displayName: row.display_name,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
        orderCount: row.order_count,
        spendCents: row.spend_cents,
        lastOrderAt: row.last_order_at,
      })),
    };
  });

  app.delete('/api/v1/admin/users/:id', async (request) => {
    const actor = requireAdmin(request);
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw httpError(422, 'USER_ID_INVALID', '用户 ID 无效');
    }
    const user = userRepo.softDeleteUser(request.server.db, id, actor);
    return { ok: true, deleted: { id: user.id, displayName: user.display_name } };
  });
}
