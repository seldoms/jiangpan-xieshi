import { requireAdmin } from '../plugins/auth.js';
import {
  batchSummary,
  listShipmentCards,
  transitionShipment,
  recordPersonalFreight,
  recordGroupFreight,
  softDeleteOrder,
  listAuditLogs,
  getShipmentWithOrder,
  httpError,
} from '../repositories/fulfillmentRepo.js';

/**
 * 管理端履约 + 运费 API。全部端点 requireAdmin。
 * 在 app.js 之外以插件形式注册（测试自行 register）。
 */
export default async function routes(app) {
  const admin = (req) => requireAdmin(req);

  // 批次汇总：缺省取最近截单 open 批次，没有 open 则取最新批次。
  app.get('/api/v1/admin/batch/summary', async (req) => {
    admin(req);
    return batchSummary(app.db, req.query.batchId);
  });

  // 发货卡片列表：按 order.seq、shipment.seq 升序。
  app.get('/api/v1/admin/shipments', async (req) => {
    admin(req);
    return listShipmentCards(app.db, req.query.batchId);
  });

  // 状态机推进/撤回。
  app.post('/api/v1/admin/shipments/:id/transition', async (req) => {
    const actor = admin(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(400, 'INVALID_ID', '发货单 id 必须是整数');
    const to = req.body?.to;
    if (typeof to !== 'string') throw httpError(400, 'INVALID_BODY', 'body.to 必填');
    return transitionShipment(app.db, id, to, actor);
  });

  // 只需录入运费；旧客户端可继续传实际重量，拼团默认按下单规格标重分摊。
  // 已打包订单提交运费后由仓储层原子推进为已发货。
  app.post('/api/v1/admin/shipments/:id/freight', async (req) => {
    const actor = admin(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(400, 'INVALID_ID', '发货单 id 必须是整数');
    const row = getShipmentWithOrder(app.db, id);
    if (!row) throw httpError(404, 'SHIPMENT_NOT_FOUND', `发货单 ${id} 不存在`);

    const body = req.body ?? {};
    if (row.source === 'group') {
      return recordGroupFreight(
        app.db,
        id,
        {
          totalFreightCents: body.totalFreightCents === undefined ? body.freightCents : body.totalFreightCents,
          memberWeights: body.memberWeights,
          adjustments: body.adjustments ?? [],
        },
        actor,
      );
    }
    const freightCents =
      body.freightCents === undefined ? null : body.freightCents;
    return recordPersonalFreight(
      app.db,
      id,
      { weightGrams: body.weightGrams, freightCents },
      actor,
    );
  });

  // 兼容旧客户端的发货快捷入口；服务端仍要求先登记快递费。
  app.post('/api/v1/admin/shipments/:id/ship', async (req) => {
    const actor = admin(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(400, 'INVALID_ID', '发货单 id 必须是整数');
    return transitionShipment(app.db, id, 'shipped', actor);
  });

  // 软删除订单，body 可带 {reason}。
  app.delete('/api/v1/admin/orders/:id', async (req) => {
    const actor = admin(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(400, 'INVALID_ID', '订单 id 必须是整数');
    return softDeleteOrder(app.db, id, req.body?.reason, actor);
  });

  // 审计查询。
  app.get('/api/v1/admin/audit-logs', async (req) => {
    admin(req);
    return {
      auditLogs: listAuditLogs(app.db, {
        entity: req.query.entity,
        entityId: req.query.entityId,
      }),
    };
  });
}
