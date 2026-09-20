import {
  BOX_CAPACITY,
  DEFAULT_PACKAGING_PRICES,
  addressAmount,
  isAfterCutoff,
  resolveCouponActivity,
} from '../money.js';
import { catalogBatchIds } from './dailyBatchRepo.js';
import { getCouponActivityState, isSpecOrderable } from './configRepo.js';

/**
 * 订单数据访问层：个人订单与拼团订单共用的创建入口（createOrder），
 * 以及用户端查询助手。所有 SQL 收敛在本文件，路由层不手写 SQL。
 */

export function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** 中国大陆手机号：11 位数字，1 开头，第二位 3-9。 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

/**
 * 清洗手机号：剔除空白与短横线（用户常从聊天记录粘贴带分隔符的号码），
 * 校验与落库都使用清洗后的纯数字串。
 */
function normalizePhone(value) {
  return typeof value === 'string' ? value.replace(/[\s-]/g, '') : value;
}

/**
 * 包装价从 settings 表读取（key: packaging.plain / packaging.gift，单位分），
 * 缺失或非法时回退到 money.js 的默认价。
 */
function readPackagingPrices(db) {
  const prices = { ...DEFAULT_PACKAGING_PRICES };
  for (const packaging of ['plain', 'gift']) {
    const row = db.get('SELECT value FROM settings WHERE key = ?', `packaging.${packaging}`);
    if (row && /^-?\d+$/.test(row.value)) {
      const parsed = Number(row.value);
      if (parsed >= 0) prices[packaging] = parsed;
    }
  }
  return prices;
}

/** 批次截单日对应的 Asia/Shanghai 日期，格式 YYMMDD。 */
export function formatOrderDateCode(isoUtc) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(isoUtc));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}`;
}

export function findOrderById(db, id) {
  return db.get('SELECT * FROM orders WHERE id = ?', id) ?? null;
}

export function findOrderByIdempotencyKey(db, idempotencyKey) {
  return db.get('SELECT * FROM orders WHERE idempotency_key = ?', idempotencyKey) ?? null;
}

export function listShipments(db, orderId) {
  return db.all('SELECT * FROM shipments WHERE order_id = ? ORDER BY seq', orderId);
}

export function listOrdersByUser(db, userId) {
  return db.all(
    'SELECT * FROM orders WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC',
    userId,
  );
}

/**
 * 管理端：**满减优惠码的使用订单**（不管取消与否，全都要列出来）。
 *
 * 关键口径与「已用次数」一致：**不过滤 orders.deleted_at** —— 取消订单是软删，
 * 但需求要求「不论取消与否都正常计数」，所以这里也要显示出来并标 `cancelled`，
 * 让管理员一眼看出 N 张里哪几张其实已经退款/取消了（不退回）。
 * 收货人手机号用 GROUP_CONCAT 串起来，手机号是同一单多地址时逐个列表。
 */
export function listCouponOrders(db, couponCode) {
  if (typeof couponCode !== 'string' || couponCode === '') return [];
  return db.all(
    `SELECT o.id, o.order_no, o.seq, o.source, o.status,
            o.crab_cents, o.packaging_cents, o.total_cents, o.discount_cents,
            o.coupon_code, o.created_at, o.deleted_at,
            u.order_code AS user_order_code, u.display_name AS user_display_name,
            (SELECT GROUP_CONCAT(s.recipient || ' ' || s.phone, '、')
               FROM shipments s WHERE s.order_id = o.id) AS recipients
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
      WHERE o.coupon_code = ?
      ORDER BY o.created_at DESC, o.id DESC`,
    couponCode,
  );
}

export function getCurrentOpenBatch(db) {
  return db.get("SELECT * FROM batches WHERE status = 'open' ORDER BY julianday(cutoff_time), id LIMIT 1") ?? null;
}

function prepareShipment(db, batch, shipment, index, ctx) {
  const label = `shipments[${index}]`;
  if (shipment === null || typeof shipment !== 'object') {
    throw httpError(400, 'SHIPMENT_INVALID', `${label} 必须是对象`);
  }
  const { recipient, phone, address, packaging } = shipment;
  if (!nonEmptyString(recipient) || !nonEmptyString(phone) || !nonEmptyString(address)) {
    throw httpError(400, 'SHIPMENT_INVALID', `${label} 需要收货人、手机号和地址`);
  }
  // 先清洗（去空白/短横）再校验格式，避免前端解析出的脏号码落库成为永久脏数据。
  const cleanPhone = normalizePhone(phone);
  if (!PHONE_PATTERN.test(cleanPhone)) {
    throw httpError(400, 'PHONE_INVALID', `${label} 手机号格式不正确，请输入 11 位手机号`);
  }
  if (packaging !== 'plain' && packaging !== 'gift') {
    throw httpError(400, 'PACKAGING_INVALID', `${label} 包装必须是 plain 或 gift`);
  }

  let copies = null;
  if (shipment.copies !== null && shipment.copies !== undefined) {
    if (!Number.isInteger(shipment.copies) || shipment.copies <= 0) {
      throw httpError(400, 'COPIES_INVALID', `${label} 份数必须是正整数`);
    }
    copies = shipment.copies;
  }

  if (!Array.isArray(shipment.items) || shipment.items.length === 0) {
    throw httpError(400, 'ITEMS_INVALID', `${label} 至少需要一条规格明细`);
  }
  const pricedItems = shipment.items.map((item, i) => {
    if (!Number.isInteger(item?.specId) || !Number.isInteger(item?.qty) || item.qty <= 0) {
      throw httpError(400, 'ITEMS_INVALID', `${label}.items[${i}] 需要 specId 和正整数 qty`);
    }
    const spec = db.get('SELECT * FROM specs WHERE id = ? AND active = 1', item.specId);
    if (!spec || (spec.batch_id !== null && !catalogBatchIds(db, batch.id).includes(spec.batch_id))) {
      throw httpError(400, 'SPEC_INVALID', `${label}.items[${i}] 规格不存在或已下架`);
    }
    if (!isSpecOrderable(spec)) {
      throw httpError(422, 'SPEC_NOT_ORDERABLE', `${spec.gender === 'male' ? '公' : '母'}${spec.weight_label} 暂未开售或已缺货，请调整后重新提交`);
    }
    ctx.specSnapshot.set(spec.id, {
      specId: spec.id,
      gender: spec.gender,
      weightLabel: spec.weight_label,
      priceCents: spec.price_cents,
    });
    return {
      specId: spec.id,
      qty: item.qty,
      priceCents: spec.price_cents,
      gender: spec.gender,
      weightLabel: spec.weight_label,
    };
  });

  const perCopyCount = pricedItems.reduce((sum, it) => sum + it.qty, 0);
  const totalCount = perCopyCount * (copies ?? 1);
  if (totalCount < BOX_CAPACITY && !ctx.confirmBelowTen) {
    throw httpError(
      422,
      'BELOW_TEN_NEEDS_CONFIRM',
      `${label} 总只数 ${totalCount} 少于 ${BOX_CAPACITY} 只，需确认后提交`,
    );
  }

  const amount = addressAmount({
    items: pricedItems,
    copies,
    packaging,
    packagingPrices: ctx.packagingPrices,
  });

  return {
    recipient: recipient.trim(),
    phone: cleanPhone,
    address: address.trim(),
    packaging,
    copies,
    // shipments.copies 列不允许 NULL：套餐模式存份数，自定义模式存盒数；
    // 原始语义保存在 items_json 的 copies 字段里。
    storedCopies: copies ?? amount.boxes,
    pricedItems,
    amount,
  };
}

/**
 * 创建订单（个人 / 拼团共用）。全部写入在一个事务内完成：
 * 批次校验（存在、open、未过截单）→ 规格定价与金额计算 → 订单号分配 → 订单、发货单、审计落库。
 *
 * @param {object} db createDb 返回的查询助手
 * @param {object} input
 * @param {number} input.batchId 批次 id
 * @param {number} input.userId 下单用户 id
 * @param {'personal'|'group'} input.source 订单来源
 * @param {string} input.idempotencyKey 幂等键，全局唯一；重复提交直接返回已有订单
 * @param {boolean} [input.confirmBelowTen] 发货单总只数少于 10 只时的用户确认
 * @param {string|null} [input.couponCode] 满减优惠码（独立券码输入框的值，不是备注）；
 *   后台可配置的限量活动：一个活动码所有用户共用，蟹款满门槛才可用，共 N 张、用完即止；
 *   「已用几次」含已取消 / 已退款（软删）的订单，不退回 —— 见 configRepo.countCouponUsage。
 *   活动未启用 / 码不对 / 用满 / 未达门槛都在 createOrder 内抛 4xx。
 *   拼团单（source === 'group'）不参与本活动，传了会被拒。
 * @param {Array} input.shipments 发货单列表：
 *   { recipient, phone, address, packaging: 'plain'|'gift',
 *     copies: number|null,           // 套餐模式为份数（每份一盒 10 只）；自定义模式传 null
 *     items: [{ specId, qty }] }     // 自定义模式为用户选配；套餐模式由调用方展开模板后传入
 * @returns {{ order: object, shipments: object[], idempotent: boolean }}
 *   order/shipments 为完整行数据；idempotent=true 表示幂等命中、未新建。
 */
export function createOrder(db, {
  batchId,
  userId,
  source,
  idempotencyKey,
  confirmBelowTen = false,
  couponCode = null,
  shipments,
}) {
  if (source !== 'personal' && source !== 'group') {
    throw httpError(400, 'SOURCE_INVALID', 'source 必须是 personal 或 group');
  }
  if (!nonEmptyString(idempotencyKey)) {
    throw httpError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键 idempotencyKey');
  }

  // 幂等命中优先于其余参数校验：重复提交直接返回已有订单
  const existing = findOrderByIdempotencyKey(db, idempotencyKey);
  if (existing) {
    // 幂等键是客户端生成的，不能因为键碰撞把别人的订单回给当前用户。
    // 拼团/个人订单以及批次也必须一致；否则应由调用方换一个键重试。
    if (
      existing.user_id !== userId
      || existing.source !== source
      || existing.batch_id !== batchId
    ) {
      throw httpError(
        409,
        'IDEMPOTENCY_KEY_CONFLICT',
        '幂等键已被其他订单使用，请更换幂等键',
      );
    }
    return { order: existing, shipments: listShipments(db, existing.id), idempotent: true };
  }

  if (!Array.isArray(shipments) || shipments.length === 0) {
    throw httpError(400, 'SHIPMENTS_REQUIRED', '至少需要一个收货地址');
  }

  return db.tx(() => {
    const batch = db.get('SELECT * FROM batches WHERE id = ?', batchId);
    if (!batch) throw httpError(404, 'BATCH_NOT_FOUND', '批次不存在');
    if (batch.status !== 'open') throw httpError(409, 'BATCH_CLOSED', '批次已关闭');
    if (isAfterCutoff(new Date(), batch.cutoff_time)) {
      throw httpError(409, 'CUTOFF_PASSED', '已过截单时间，无法提交');
    }

    const packagingPrices = readPackagingPrices(db);
    const specSnapshot = new Map();
    const prepared = shipments.map((shipment, index) =>
      prepareShipment(db, batch, shipment, index, { packagingPrices, specSnapshot, confirmBelowTen }));

    const { maxSeq } = db.get('SELECT MAX(seq) AS maxSeq FROM orders WHERE batch_id = ?', batchId);
    const seq = (maxSeq ?? 0) + 1;
    const orderNo = `D${formatOrderDateCode(batch.cutoff_time)}-${String(seq).padStart(4, '0')}`;
    const now = new Date().toISOString();

    const crabCents = prepared.reduce((sum, p) => sum + p.amount.crabCents, 0);
    const packagingCents = prepared.reduce((sum, p) => sum + p.amount.packagingCents, 0);

    // 满减优惠码：拼团单走另一条链路，本期不参与（用户口径）。
    // 防御性拒绝，避免拼团链路将来误传券码后悄悄打折。
    if (source === 'group' && couponCode !== null && couponCode !== undefined && String(couponCode).trim() !== '') {
      throw httpError(400, 'COUPON_NOT_FOR_GROUP', '拼团订单不参与满减优惠活动');
    }
    // 读活动配置 + **已用张数**（含已取消/退款订单，不退回）→ 判定。
    // 顺序：未启用 / 码不对 / 用满 N 张 / 未达门槛都会在此抛 4xx（见 money.resolveCouponActivity）。
    // 门槛按**蟹款**判定（不含包装费、运费）。
    const couponActivity = getCouponActivityState(db);
    const resolvedCoupon = resolveCouponActivity({
      activity: couponActivity,
      code: source === 'group' ? null : couponCode,
      crabCents,
      usedCount: couponActivity.used,
    });
    const appliedCoupon = resolvedCoupon?.couponCode ?? null;
    const discountCents = resolvedCoupon?.discountCents ?? 0;
    // 减免不会超过蟹款（resolveCouponActivity 内保证），总额因此不会为负。
    const totalCents = crabCents + packagingCents - discountCents;
    const configSnapshot = JSON.stringify({
      boxCapacity: BOX_CAPACITY,
      cutoffTime: batch.cutoff_time,
      packagingPrices,
      specs: [...specSnapshot.values()],
      coupon: appliedCoupon ? { code: appliedCoupon, discountCents } : null,
    });

    let orderId;
    try {
      orderId = db.run(
        `INSERT INTO orders (batch_id, seq, order_no, user_id, source, status,
           crab_cents, packaging_cents, freight_cents, total_cents, discount_cents, coupon_code,
           config_snapshot, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        batchId, seq, orderNo, userId, source,
        crabCents, packagingCents, totalCents, discountCents, appliedCoupon,
        configSnapshot, idempotencyKey, now,
      ).lastInsertRowid;
    } catch (err) {
      // 并发下幂等键撞唯一约束：返回已存在的那一单
      if (typeof err?.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
        const duplicate = findOrderByIdempotencyKey(db, idempotencyKey);
        if (duplicate) {
          return { order: duplicate, shipments: listShipments(db, duplicate.id), idempotent: true };
        }
      }
      throw err;
    }

    for (const [i, p] of prepared.entries()) {
      db.run(
        `INSERT INTO shipments (order_id, seq, recipient, phone, address, copies, packaging,
           items_json, crab_cents, packaging_cents, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fishing', ?, ?)`,
        orderId, i + 1, p.recipient, p.phone, p.address, p.storedCopies, p.packaging,
        JSON.stringify({ copies: p.copies, items: p.pricedItems }),
        p.amount.crabCents, p.amount.packagingCents, now, now,
      );
    }

    db.run(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity, entity_id, detail, created_at)
       VALUES ('user', ?, 'order.create', 'order', ?, ?, ?)`,
      userId, orderId, JSON.stringify({ orderNo, source, totalCents, discountCents, couponCode: appliedCoupon }), now,
    );

    return { order: findOrderById(db, orderId), shipments: listShipments(db, orderId), idempotent: false };
  })();
}
