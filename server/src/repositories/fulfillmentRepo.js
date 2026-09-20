import { allocatePackagingAndFreight, specWeightGrams } from '../money.js';
import { memberSnapshotItems } from './groupRepo.js';

/**
 * 履约数据访问层：批次汇总、发货卡片、状态机、运费登记、软删除和审计。
 * SQL 只收敛在本文件；路由层不手写 prepare。
 */

export const SHIPMENT_STATUSES = ['fishing', 'packed', 'shipped'];

// 状态机：fishing → packed → shipped；打包后可撤回到捕捞中。
const ALLOWED_TRANSITIONS = {
  fishing: ['packed'],
  packed: ['shipped', 'fishing'],
  shipped: [],
};

export function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function now() {
  return new Date().toISOString();
}

export function insertAudit(db, { actorType, actorId, action, entity, entityId, detail }) {
  db.run(
    'INSERT INTO audit_logs (actor_type, actor_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    actorType,
    actorId ?? null,
    action,
    entity,
    entityId ?? null,
    detail === undefined ? null : JSON.stringify(detail),
    now(),
  );
}

/**
 * 批次解析：传入 batchId 必须存在；缺省取最近截单的 open 批次，没有 open 则取最新批次。
 */
export function resolveBatch(db, batchId) {
  if (batchId !== undefined && batchId !== null && batchId !== '') {
    const id = Number(batchId);
    if (!Number.isInteger(id)) {
      throw httpError(400, 'INVALID_BATCH_ID', `batchId 必须是整数，收到 ${batchId}`);
    }
    const batch = db.get('SELECT * FROM batches WHERE id = ?', id);
    if (!batch) throw httpError(404, 'BATCH_NOT_FOUND', `批次 ${id} 不存在`);
    return batch;
  }
  const open = db.get(
    "SELECT * FROM batches WHERE status = 'open' ORDER BY julianday(cutoff_time), id LIMIT 1",
  );
  if (open) return open;
  const latest = db.get('SELECT * FROM batches ORDER BY id DESC LIMIT 1');
  if (!latest) throw httpError(404, 'BATCH_NOT_FOUND', '尚无任何批次');
  return latest;
}

/**
 * 解析 shipments.items_json。
 * 定版格式（写侧）：{ copies: number|null, items: [{ specId, qty, priceCents, gender, weightLabel }] }，
 * copies 为套餐份数（items 描述每份内容），null 表示自定义模式（items 为全部明细）。
 * 兼容早期纯数组格式：[{ gender, weightLabel, quantity|qty, ... }]（视为总量明细，copies 不参与）。
 */
export function parseShipmentItems(itemsJson) {
  const payload = JSON.parse(itemsJson);
  if (Array.isArray(payload)) {
    return { copies: null, items: payload.map((it) => ({ ...it, qty: it.qty ?? it.quantity })) };
  }
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return {
    copies: Number.isInteger(payload?.copies) ? payload.copies : null,
    items: items.map((it) => ({ ...it, qty: it.qty ?? it.quantity })),
  };
}

/**
 * 批次捕捞汇总：排除软删除订单；按公母 + 规格汇总发货单 items_json 数量。
 * 套餐模式按份数（copies）放大每份数量。
 */
export function batchSummary(db, batchId) {
  const batch = resolveBatch(db, batchId);
  const orderCount = db.get(
    'SELECT COUNT(*) AS n FROM orders WHERE batch_id = ? AND deleted_at IS NULL',
    batch.id,
  ).n;
  const shipments = db.all(
    `SELECT s.status, s.items_json, s.crab_cents, s.packaging_cents, s.freight_cents
     FROM shipments s JOIN orders o ON o.id = s.order_id
     WHERE o.batch_id = ? AND o.deleted_at IS NULL`,
    batch.id,
  );

  const totals = new Map();
  for (const s of shipments) {
    const { copies, items } = parseShipmentItems(s.items_json);
    const multiplier = copies ?? 1;
    for (const item of items) {
      const key = `${item.gender}|${item.weightLabel}`;
      totals.set(key, (totals.get(key) ?? 0) + item.qty * multiplier);
    }
  }
  const totalsBySpec = [...totals.entries()]
    .map(([key, quantity]) => {
      const [gender, weightLabel] = key.split('|');
      return { gender, weightLabel, quantity };
    })
    .sort(
      (a, b) =>
        a.gender.localeCompare(b.gender) || a.weightLabel.localeCompare(b.weightLabel),
    );

  const statusCounts = { fishing: 0, packed: 0, shipped: 0 };
  // 预计收入 = 本批全部发货单的蟹款 + 包装费 + 已登记运费；未登记运费的单独计数。
  const revenue = { crabCents: 0, packagingCents: 0, freightCents: 0, freightPendingCount: 0 };
  for (const s of shipments) {
    statusCounts[s.status] += 1;
    revenue.crabCents += s.crab_cents ?? 0;
    revenue.packagingCents += s.packaging_cents ?? 0;
    revenue.freightCents += s.freight_cents ?? 0;
    if (s.freight_cents == null) revenue.freightPendingCount += 1;
  }

  return {
    batch: {
      id: batch.id,
      name: batch.name,
      cutoffTime: batch.cutoff_time,
      status: batch.status,
      createdAt: batch.created_at,
    },
    totalsBySpec,
    orderCount,
    shipmentCount: shipments.length,
    statusCounts,
    revenueCents: revenue.crabCents + revenue.packagingCents + revenue.freightCents,
    revenue,
  };
}

export function toShipmentView(s, extra = {}) {
  return {
    id: s.id,
    orderId: s.order_id,
    seq: s.seq,
    recipient: s.recipient,
    phone: s.phone,
    address: s.address,
    copies: s.copies,
    packaging: s.packaging,
    items: JSON.parse(s.items_json),
    crabCents: s.crab_cents,
    packagingCents: s.packaging_cents,
    actualWeightGrams: s.actual_weight_grams,
    freightCents: s.freight_cents,
    status: s.status,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    ...extra,
  };
}

/**
 * 发货卡片列表：按 order.seq、shipment.seq 升序，排除软删除订单。
 */
export function listShipmentCards(db, batchId) {
  const batch = resolveBatch(db, batchId);
  const rows = db.all(
    `SELECT s.*, o.order_no, o.source, o.seq AS order_seq
     FROM shipments s JOIN orders o ON o.id = s.order_id
     WHERE o.batch_id = ? AND o.deleted_at IS NULL
     ORDER BY o.seq ASC, s.seq ASC`,
    batch.id,
  );
  return {
    batch: {
      id: batch.id,
      name: batch.name,
      cutoffTime: batch.cutoff_time,
      status: batch.status,
      createdAt: batch.created_at,
    },
    shipments: rows.map((r) =>
      toShipmentView(r, { orderNo: r.order_no, source: r.source }),
    ),
  };
}

export function getShipmentWithOrder(db, shipmentId) {
  return db.get(
    `SELECT s.*, o.order_no, o.source, o.batch_id, o.deleted_at AS order_deleted_at
     FROM shipments s JOIN orders o ON o.id = s.order_id
     WHERE s.id = ?`,
    shipmentId,
  );
}

function requireShipment(db, shipmentId) {
  const row = getShipmentWithOrder(db, shipmentId);
  if (!row) throw httpError(404, 'SHIPMENT_NOT_FOUND', `发货单 ${shipmentId} 不存在`);
  // 软删除只隐藏订单是不够的；删除后不能再通过已知发货单 id 推进状态或改金额。
  if (row.order_deleted_at !== null) {
    throw httpError(409, 'ORDER_DELETED', '订单已删除，不能继续操作发货单');
  }
  return row;
}

/**
 * 状态机推进/撤回：事务内读当前状态 → 校验 → 更新 → 写审计。
 * 同一状态重复推进不在允许表内，返回 409 INVALID_TRANSITION（幂等防重）。
 */
export function transitionShipment(db, shipmentId, to, actor) {
  if (!SHIPMENT_STATUSES.includes(to)) {
    throw httpError(400, 'INVALID_STATUS', `非法目标状态 ${to}`);
  }
  return db.tx(() => {
    const row = requireShipment(db, shipmentId);
    if (!ALLOWED_TRANSITIONS[row.status].includes(to)) {
      throw httpError(
        409,
        'INVALID_TRANSITION',
        `不允许从 ${row.status} 变更为 ${to}`,
      );
    }
    if (to === 'shipped' && row.freight_cents === null) {
      throw httpError(409, 'FREIGHT_REQUIRED', '提交该单快递费后才能标记已发货');
    }
    const ts = now();
    db.run(
      'UPDATE shipments SET status = ?, updated_at = ? WHERE id = ?',
      to,
      ts,
      shipmentId,
    );
    insertAudit(db, {
      actorType: 'admin',
      actorId: actor.id,
      action: 'shipment.transition',
      entity: 'shipment',
      entityId: shipmentId,
      detail: { from: row.status, to, orderNo: row.order_no },
    });
    return toShipmentView(db.get('SELECT * FROM shipments WHERE id = ?', shipmentId), {
      orderNo: row.order_no,
      source: row.source,
    });
  })();
}

export function toOrderView(o) {
  return {
    id: o.id,
    batchId: o.batch_id,
    seq: o.seq,
    orderNo: o.order_no,
    source: o.source,
    status: o.status,
    crabCents: o.crab_cents,
    packagingCents: o.packaging_cents,
    freightCents: o.freight_cents,
    totalCents: o.total_cents,
    deletedAt: o.deleted_at,
  };
}

/**
 * 订单金额重算：订单运费 = 各发货单运费之和；任一发货单运费为 null 则整体为 null（待确认）。
 * total_cents = crab_cents + packaging_cents + (freight_cents ?? 0)。
 */
export function recalcOrderAmounts(db, orderId) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  const rows = db.all('SELECT freight_cents FROM shipments WHERE order_id = ?', orderId);
  let sum = 0;
  let pending = false;
  for (const r of rows) {
    if (r.freight_cents === null) pending = true;
    else sum += r.freight_cents;
  }
  const freightCents = pending || rows.length === 0 ? null : sum;
  const totalCents = order.crab_cents + order.packaging_cents + (freightCents ?? 0);
  db.run(
    'UPDATE orders SET freight_cents = ?, total_cents = ? WHERE id = ?',
    freightCents,
    totalCents,
    orderId,
  );
  return db.get('SELECT * FROM orders WHERE id = ?', orderId);
}

function assertNonNegativeInt(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw httpError(400, 'INVALID_AMOUNT', `${name} 必须是非负整数，收到 ${value}`);
  }
}

/**
 * 个人订单发货单：登记/修改运费，提交后直接发货；重量仅兼容旧客户端。
 */
export function recordPersonalFreight(db, shipmentId, { weightGrams, freightCents }, actor) {
  if (weightGrams !== undefined) assertNonNegativeInt(weightGrams, 'weightGrams');
  if (freightCents !== null) assertNonNegativeInt(freightCents, 'freightCents');
  return db.tx(() => {
    const row = requireShipment(db, shipmentId);
    if (row.source === 'group') {
      throw httpError(400, 'GROUP_ORDER', '拼团发货单请使用拼团运费录入格式');
    }
    if (row.status === 'fishing') {
      throw httpError(409, 'PACKING_REQUIRED', '完成打包后才能登记快递费');
    }
    if (freightCents === null) {
      throw httpError(409, 'FREIGHT_REQUIRED', '请填写本单快递费，免运费请填 0');
    }
    const nextStatus = 'shipped';
    db.run(
      'UPDATE shipments SET actual_weight_grams = ?, freight_cents = ?, status = ?, updated_at = ? WHERE id = ?',
      weightGrams ?? row.actual_weight_grams,
      freightCents,
      nextStatus,
      now(),
      shipmentId,
    );
    const order = recalcOrderAmounts(db, row.order_id);
    insertAudit(db, {
      actorType: 'admin',
      actorId: actor.id,
      action: 'shipment.freight',
      entity: 'shipment',
      entityId: shipmentId,
      detail: { orderNo: row.order_no, weightGrams, freightCents },
    });
    if (nextStatus !== row.status) {
      insertAudit(db, {
        actorType: 'admin',
        actorId: actor.id,
        action: 'shipment.transition',
        entity: 'shipment',
        entityId: shipmentId,
        detail: { orderNo: row.order_no, from: row.status, to: nextStatus, reason: 'freight_submitted' },
      });
    }
    return {
      shipment: toShipmentView(
        db.get('SELECT * FROM shipments WHERE id = ?', shipmentId),
        { orderNo: row.order_no, source: row.source },
      ),
      order: toOrderView(order),
    };
  })();
}

/**
 * 拼团发货单：运费 + 包装费合并成一份总额，按下单时各规格重量 × 数量一次性分摊；
 * 兼容旧 memberWeights 实重。分摊按 group_members.submitted_order 升序对齐；
 * adjustments 对指定成员人工改价（必须带 reason）；除不尽的零头抹零由平台承担，
 * 即 Σ 成员分摊 <= 运费 + 包装费（只保证不上溢，不再补给团长）。
 */
export function recordGroupFreight(
  db,
  shipmentId,
  { totalFreightCents, memberWeights, adjustments = [] },
  actor,
) {
  assertNonNegativeInt(totalFreightCents, 'totalFreightCents');
  const useActualWeights = memberWeights !== undefined;
  if (useActualWeights && (!Array.isArray(memberWeights) || memberWeights.length === 0)) {
    throw httpError(400, 'INVALID_MEMBER_WEIGHTS', 'memberWeights 必须是非空数组');
  }
  if (!Array.isArray(adjustments)) {
    throw httpError(400, 'INVALID_ADJUSTMENTS', 'adjustments 必须是数组');
  }

  return db.tx(() => {
    const row = requireShipment(db, shipmentId);
    if (row.source !== 'group') {
      throw httpError(400, 'NOT_GROUP_ORDER', '该发货单不属于拼团订单');
    }
    if (row.status === 'fishing') {
      throw httpError(409, 'PACKING_REQUIRED', '完成打包后才能登记快递费');
    }
    const nextStatus = row.status === 'packed' ? 'shipped' : row.status;
    const group = db.get(
      'SELECT * FROM groups WHERE submitted_order_id = ?',
      row.order_id,
    );
    if (!group) {
      throw httpError(404, 'GROUP_NOT_FOUND', '未找到该订单对应的拼团');
    }
    const members = db.all(
      'SELECT * FROM group_members WHERE group_id = ? ORDER BY submitted_order ASC, id ASC',
      group.id,
    );
    if (members.length === 0) {
      throw httpError(400, 'NO_MEMBERS', '拼团没有成员，无法分摊运费');
    }

    const weightById = new Map();
    const inputWeights = useActualWeights ? memberWeights : members.map((member) => ({
      memberId: member.id,
      weightGrams: memberSnapshotItems(member).reduce((sum, item) => {
        const grams = specWeightGrams(item.weightLabel);
        if (grams === null || !Number.isSafeInteger(item.qty) || item.qty <= 0) {
          throw httpError(422, 'SPEC_WEIGHT_INVALID', `成员 ${member.name} 的历史规格无法识别重量，请核对订单规格`);
        }
        const total = sum + grams * item.qty;
        if (!Number.isSafeInteger(total)) throw httpError(422, 'SPEC_WEIGHT_INVALID', '规格总重量超出计算范围');
        return total;
      }, 0),
    }));
    for (const mw of inputWeights) {
      if (!Number.isInteger(mw?.memberId) || mw.memberId <= 0) {
        throw httpError(400, 'INVALID_MEMBER_ID', 'memberWeights.memberId 必须是正整数');
      }
      if (!members.some((m) => m.id === mw.memberId)) {
        throw httpError(400, 'UNKNOWN_MEMBER', `成员 ${mw.memberId} 不在该拼团中`);
      }
      if (weightById.has(mw.memberId)) {
        throw httpError(400, 'DUPLICATE_MEMBER_WEIGHT', `成员 ${mw.memberId} 的重量重复提交`);
      }
      assertNonNegativeInt(mw.weightGrams, `memberWeights[${mw.memberId}].weightGrams`);
      weightById.set(mw.memberId, mw.weightGrams);
    }
    for (const m of members) {
      if (!weightById.has(m.id)) {
        throw httpError(400, 'MISSING_MEMBER_WEIGHT', `成员 ${m.name} 缺少实际重量`);
      }
    }
    const weights = members.map((m) => weightById.get(m.id));

    const adjById = new Map();
    for (const adj of adjustments) {
      if (!Number.isInteger(adj?.memberId) || adj.memberId <= 0) {
        throw httpError(400, 'INVALID_MEMBER_ID', 'adjustments.memberId 必须是正整数');
      }
      if (!members.some((m) => m.id === adj.memberId)) {
        throw httpError(400, 'UNKNOWN_MEMBER', `改价成员 ${adj.memberId} 不在该拼团中`);
      }
      if (adjById.has(adj.memberId)) {
        throw httpError(400, 'DUPLICATE_MEMBER_ADJUSTMENT', `成员 ${adj.memberId} 的改价重复提交`);
      }
      assertNonNegativeInt(adj.freightCents, `adjustments[${adj.memberId}].freightCents`);
      if (typeof adj.reason !== 'string' || adj.reason.trim() === '') {
        throw httpError(400, 'ADJUST_REASON_REQUIRED', '人工改价必须填写原因');
      }
      adjById.set(adj.memberId, { freightCents: adj.freightCents, reason: adj.reason.trim() });
    }

    // 运费 + 包装费合并成一份总额，按成员重量一次性分完；除不尽的零头抹零（平台承担）。
    const packagingCents = row.packaging_cents ?? 0;
    const combinedTotalCents = packagingCents + totalFreightCents;
    const feeLines = allocatePackagingAndFreight({
      packagingCents,
      freightCents: totalFreightCents,
      weights,
    });
    const finalShares = members.map((m, i) =>
      adjById.has(m.id) ? adjById.get(m.id).freightCents : feeLines[i].freightShareCents,
    );

    // 抹零口径：分摊之和允许小于总额（零头平台承担），但不允许超过总额（不让成员多付）。
    const collectedCents = finalShares.reduce((a, b) => a + b, 0);
    if (collectedCents > combinedTotalCents) {
      throw httpError(
        400,
        'FREIGHT_SUM_MISMATCH',
        '人工改价分摊之和超出拼团总费用（运费 + 包装费）',
      );
    }

    for (const [i, m] of members.entries()) {
      const adj = adjById.get(m.id);
      db.run(
        `UPDATE group_members
         SET actual_weight_grams = ?, freight_share_cents = ?, freight_adjusted = ?, adjust_reason = ?
         WHERE id = ?`,
        useActualWeights ? weights[i] : m.actual_weight_grams,
        finalShares[i],
        adj ? 1 : 0,
        adj ? adj.reason : null,
        m.id,
      );
    }

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    db.run(
      'UPDATE shipments SET actual_weight_grams = ?, freight_cents = ?, status = ?, updated_at = ? WHERE id = ?',
      useActualWeights ? totalWeight : row.actual_weight_grams,
      totalFreightCents,
      nextStatus,
      now(),
      shipmentId,
    );
    const order = recalcOrderAmounts(db, row.order_id);

    insertAudit(db, {
      actorType: 'admin',
      actorId: actor.id,
      action: 'shipment.freight',
      entity: 'shipment',
      entityId: shipmentId,
      detail: {
        orderNo: row.order_no,
        groupId: group.id,
        totalFreightCents,
        weightSource: useActualWeights ? 'actual' : 'specification',
        totalWeightGrams: totalWeight,
        memberShares: members.map((m, i) => ({
          memberId: m.id,
          name: m.name,
          weightGrams: weights[i],
          freightShareCents: finalShares[i],
        })),
      },
    });
    if (nextStatus !== row.status) {
      insertAudit(db, {
        actorType: 'admin',
        actorId: actor.id,
        action: 'shipment.transition',
        entity: 'shipment',
        entityId: shipmentId,
        detail: { orderNo: row.order_no, from: row.status, to: nextStatus, reason: 'freight_submitted' },
      });
    }
    for (const m of members) {
      const adj = adjById.get(m.id);
      if (!adj) continue;
      insertAudit(db, {
        actorType: 'admin',
        actorId: actor.id,
        action: 'member.freight_adjust',
        entity: 'group_member',
        entityId: m.id,
        detail: {
          orderNo: row.order_no,
          memberName: m.name,
          freightCents: adj.freightCents,
          reason: adj.reason,
        },
      });
    }

    return {
      shipment: toShipmentView(
        db.get('SELECT * FROM shipments WHERE id = ?', shipmentId),
        { orderNo: row.order_no, source: row.source },
      ),
      order: toOrderView(order),
      members: db
        .all(
          'SELECT * FROM group_members WHERE group_id = ? ORDER BY submitted_order ASC, id ASC',
          group.id,
        )
        .map((m, i) => ({
          id: m.id,
          name: m.name,
          submittedOrder: m.submitted_order,
          quantity: m.quantity,
          actualWeightGrams: m.actual_weight_grams,
          // 合并均摊明细：包装 + 运费两项之和 = 该成员分摊到的那一份（人工改价成员以改价金额为准）
          packagingShareCents: feeLines[i]?.packagingShareCents ?? null,
          freightShareCents: m.freight_share_cents,
          freightAdjusted: m.freight_adjusted === 1,
          adjustReason: m.adjust_reason,
        })),
    };
  })();
}

/**
 * 软删除订单：deleted_at=now；审计记录操作者、订单号、删除时金额快照、原因。
 */
export function softDeleteOrder(db, orderId, reason, actor) {
  return db.tx(() => {
    const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!order) throw httpError(404, 'ORDER_NOT_FOUND', `订单 ${orderId} 不存在`);
    if (order.deleted_at !== null) {
      throw httpError(409, 'ORDER_ALREADY_DELETED', `订单 ${order.order_no} 已删除`);
    }
    db.run('UPDATE orders SET deleted_at = ? WHERE id = ?', now(), orderId);
    insertAudit(db, {
      actorType: 'admin',
      actorId: actor.id,
      action: 'order.delete',
      entity: 'order',
      entityId: orderId,
      detail: {
        orderNo: order.order_no,
        reason: reason ?? null,
        amountSnapshot: {
          crabCents: order.crab_cents,
          packagingCents: order.packaging_cents,
          freightCents: order.freight_cents,
          totalCents: order.total_cents,
        },
      },
    });
    return { id: order.id, orderNo: order.order_no, deleted: true };
  })();
}

export function listAuditLogs(db, { entity, entityId }) {
  const conditions = [];
  const params = [];
  if (entity) {
    conditions.push('entity = ?');
    params.push(entity);
  }
  if (entityId !== undefined && entityId !== null && entityId !== '') {
    const id = Number(entityId);
    if (!Number.isInteger(id)) {
      throw httpError(400, 'INVALID_ENTITY_ID', `entityId 必须是整数，收到 ${entityId}`);
    }
    conditions.push('entity_id = ?');
    params.push(id);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.all(
    `SELECT * FROM audit_logs${where} ORDER BY id DESC LIMIT 200`,
    ...params,
  );
  return rows.map((r) => ({
    id: r.id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    detail: r.detail === null ? null : JSON.parse(r.detail),
    createdAt: r.created_at,
  }));
}
