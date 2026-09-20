import { requireAdmin, requireUser } from '../plugins/auth.js';
import { BOX_CAPACITY } from '../money.js';
import { getCouponActivityState } from '../repositories/configRepo.js';
import {
  createOrder,
  findOrderById,
  findOrderByIdempotencyKey,
  getCurrentOpenBatch,
  httpError,
  listCouponOrders,
  listOrdersByUser,
  listShipments,
} from '../repositories/orderRepo.js';

/**
 * 用户端订单路由。全部走 requireUser（X-Order-Code 下单码）。
 * 注意：路由插件由 index.js / 测试自行 register，app.js 不直接挂载。
 */

function presentOrderAmount(row) {
  return {
    crabCents: row.crab_cents,
    packagingCents: row.packaging_cents,
    freightCents: row.freight_cents,
    // 满减优惠码：活动码原文 + 实际减免（total_cents 已扣减）。不用券时为 null / 0。
    discountCents: row.discount_cents ?? 0,
    couponCode: row.coupon_code ?? null,
    totalCents: row.total_cents,
  };
}

function presentOrderSummary(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    seq: row.seq,
    orderNo: row.order_no,
    source: row.source,
    status: row.status,
    amount: presentOrderAmount(row),
    createdAt: row.created_at,
  };
}

function presentOrder(row) {
  return {
    ...presentOrderSummary(row),
    idempotencyKey: row.idempotency_key,
    configSnapshot: JSON.parse(row.config_snapshot),
  };
}

function presentShipmentAmount(row) {
  return {
    crabCents: row.crab_cents,
    packagingCents: row.packaging_cents,
    freightCents: row.freight_cents, // null = 运费待确认
    totalCents: row.crab_cents + row.packaging_cents + (row.freight_cents ?? 0),
  };
}

function presentShipment(row) {
  const payload = JSON.parse(row.items_json);
  return {
    id: row.id,
    seq: row.seq,
    recipient: row.recipient,
    phone: row.phone,
    address: row.address,
    packaging: row.packaging,
    copies: payload.copies ?? null, // 套餐模式为份数；自定义模式为 null
    boxes: payload.copies ?? row.copies, // 自定义模式下 copies 列存的是盒数
    items: payload.items,
    amount: presentShipmentAmount(row),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 套餐模式：templateId → 展开模板明细为 items + copies，包装取自模板。
 * 自定义模式：直接传 items（copies 留空）。
 */
function expandShipment(db, raw, index) {
  const label = `shipments[${index}]`;
  if (raw === null || typeof raw !== 'object') {
    throw httpError(400, 'SHIPMENT_INVALID', `${label} 必须是对象`);
  }
  if (raw.templateId !== undefined && raw.templateId !== null) {
    if (raw.items !== undefined) {
      throw httpError(400, 'SHIPMENT_INVALID', `${label} templateId 与 items 只能二选一`);
    }
    const template = db.get(
      'SELECT * FROM package_templates WHERE id = ? AND active = 1',
      raw.templateId,
    );
    if (!template) {
      throw httpError(400, 'TEMPLATE_INVALID', `${label} 套餐模板不存在或已停用`);
    }
    const templateItems = db.all(
      'SELECT spec_id, quantity FROM package_template_items WHERE template_id = ? ORDER BY id',
      template.id,
    );
    const totalCount = templateItems.reduce((sum, it) => sum + it.quantity, 0);
    if (totalCount !== BOX_CAPACITY) {
      throw httpError(400, 'TEMPLATE_INVALID', `${label} 套餐模板每份必须刚好 ${BOX_CAPACITY} 只`);
    }
    return {
      recipient: raw.recipient,
      phone: raw.phone,
      address: raw.address,
      packaging: template.packaging,
      copies: raw.copies ?? 1,
      items: templateItems.map((it) => ({ specId: it.spec_id, qty: it.quantity })),
    };
  }
  return {
    recipient: raw.recipient,
    phone: raw.phone,
    address: raw.address,
    packaging: raw.packaging ?? 'plain',
    copies: raw.copies ?? null,
    items: raw.items,
  };
}

function loadOwnedOrder(db, params, user) {
  const id = Number(params.id);
  const order = Number.isInteger(id) ? findOrderById(db, id) : null;
  if (!order || order.deleted_at) {
    throw httpError(404, 'ORDER_NOT_FOUND', '订单不存在');
  }
  if (order.user_id !== user.id) {
    throw httpError(403, 'ORDER_FORBIDDEN', '无权查看该订单');
  }
  return order;
}

export default async function routes(app) {
  app.post('/api/v1/orders', async (request, reply) => {
    const user = requireUser(request);
    const body = request.body ?? {};
    const batch = getCurrentOpenBatch(app.db);
    if (!batch) throw httpError(409, 'NO_OPEN_BATCH', '当前没有开放下单的批次');
    if (!Array.isArray(body.shipments) || body.shipments.length === 0) {
      throw httpError(400, 'SHIPMENTS_REQUIRED', '至少需要一个收货地址');
    }

    const shipments = body.shipments.map((s, i) => expandShipment(app.db, s, i));
    // 满减优惠码来自独立的券码输入框（不是备注）；null/空串 = 不用券。
    // 活动未启用 / 码不对 / 已用满 N 张 / 未达门槛，都在 createOrder 内抛 4xx。
    const couponCode = body.couponCode === undefined || body.couponCode === null
      ? null
      : String(body.couponCode);
    const existing = typeof body.idempotencyKey === 'string'
      ? findOrderByIdempotencyKey(app.db, body.idempotencyKey) : null;
    const result = createOrder(app.db, {
      batchId: existing?.batch_id ?? batch.id,
      userId: user.id,
      source: 'personal',
      idempotencyKey: body.idempotencyKey,
      confirmBelowTen: body.confirmBelowTen === true,
      couponCode,
      shipments,
    });

    if (body.draftId !== undefined && body.draftId !== null) {
      app.db.run('DELETE FROM cart_drafts WHERE id = ? AND user_id = ?', body.draftId, user.id);
    }

    reply.code(result.idempotent ? 200 : 201);
    return {
      order: presentOrder(result.order),
      shipments: result.shipments.map(presentShipment),
    };
  });

  app.get('/api/v1/orders', async (request) => {
    const user = requireUser(request);
    return { orders: listOrdersByUser(app.db, user.id).map(presentOrderSummary) };
  });

  app.get('/api/v1/orders/:id', async (request) => {
    const user = requireUser(request);
    const order = loadOwnedOrder(app.db, request.params, user);
    return {
      order: presentOrder(order),
      shipments: listShipments(app.db, order.id).map(presentShipment),
    };
  });

  app.get('/api/v1/orders/:id/repurchase-config', async (request) => {
    const user = requireUser(request);
    const order = loadOwnedOrder(app.db, request.params, user);
    return {
      shipments: listShipments(app.db, order.id).map((row) => {
        const payload = JSON.parse(row.items_json);
        return {
          packaging: row.packaging,
          copies: payload.copies ?? null,
          items: payload.items.map(({ specId, qty }) => ({ specId, qty })),
        };
      }),
    };
  });

  /**
   * 管理端：满减优惠码的**使用订单**（订单号 / 下单人 / 蟹款 / 立减 / 下单时间 / 是否已取消）。
   *
   * 口径与「已用张数」严格一致：**包含已取消 / 已退款（软删）的订单** ——
   * 需求要求「不论取消与否都正常计数」，所以这里既计数、也照实展示，并标 cancelled。
   */
  app.get('/api/v1/admin/coupon/orders', async (request) => {
    requireAdmin(request);
    const coupon = getCouponActivityState(app.db);
    return {
      coupon,
      orders: listCouponOrders(app.db, coupon.code).map((row) => ({
        id: row.id,
        orderNo: row.order_no,
        source: row.source,
        status: row.status,
        cancelled: row.deleted_at !== null,
        cancelledAt: row.deleted_at ?? null,
        crabCents: row.crab_cents,
        packagingCents: row.packaging_cents,
        discountCents: row.discount_cents ?? 0,
        totalCents: row.total_cents,
        couponCode: row.coupon_code,
        createdAt: row.created_at,
        userOrderCode: row.user_order_code ?? '',
        userDisplayName: row.user_display_name ?? '',
        recipients: row.recipients ?? '',
      })),
    };
  });
}
