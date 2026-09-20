export const BOX_CAPACITY = 10;

export const DEFAULT_PACKAGING_PRICES = Object.freeze({ plain: 0, gift: 1000 });

/** 规格标重用于运费比例，不代表实际称重；1 两 = 50 克。 */
export function specWeightGrams(label) {
  const normalized = String(label ?? '').normalize('NFKC').replace(/\s/g, '');
  const match = normalized.match(/^(\d+(?:\.\d+)?|[一二三四五六七八九十两]+)(两|克|g)(半)?$/i);
  if (!match || (match[3] && match[2] !== '两')) return null;
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let value = Number(match[1]);
  if (Number.isNaN(value)) {
    if (match[1] in digits) value = digits[match[1]];
    else {
      const tens = match[1].match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
      if (!tens) return null;
      value = (digits[tens[1]] ?? 1) * 10 + (digits[tens[2]] ?? 0);
    }
  }
  const grams = (value + (match[3] ? 0.5 : 0)) * (match[2] === '两' ? 50 : 1);
  return Number.isSafeInteger(grams) && grams > 0 ? grams : null;
}

function assertInt(value, name) {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got ${value}`);
  }
}

function assertNonNegativeInt(value, name) {
  assertInt(value, name);
  if (value < 0) throw new Error(`${name} must be >= 0, got ${value}`);
}

/**
 * 盒数规则：每盒固定 10 只，不足 10 只也算 1 盒。
 */
export function boxesFor(count) {
  assertInt(count, 'count');
  if (count <= 0) throw new Error(`count must be > 0, got ${count}`);
  return Math.max(1, Math.ceil(count / BOX_CAPACITY));
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items must be a non-empty array');
  }
  for (const [i, item] of items.entries()) {
    assertNonNegativeInt(item?.priceCents, `items[${i}].priceCents`);
    assertInt(item?.qty, `items[${i}].qty`);
    if (item.qty <= 0) throw new Error(`items[${i}].qty must be > 0, got ${item.qty}`);
  }
}

/**
 * 单个地址的金额计算，金额一律整数分。
 *
 * 套餐模式（copies >= 1）：items 描述每一份（每盒 10 只）的内容，盒数 = copies，
 * 蟹款 = 每份蟹款 × 份数。
 * 自定义模式（copies 缺省）：items 是该地址全部蟹的明细，
 * 盒数 = boxesFor(该地址总只数)，蟹款 = Σ price×qty。
 *
 * 包装费 = 盒数 × 对应包装单价；同地址多个礼盒套装按盒数分别累加。
 */
export function addressAmount({
  items,
  copies = null,
  packaging = 'plain',
  packagingPrices = DEFAULT_PACKAGING_PRICES,
}) {
  validateItems(items);
  if (packaging !== 'plain' && packaging !== 'gift') {
    throw new Error(`packaging must be "plain" or "gift", got ${packaging}`);
  }
  const pricePerBox = packagingPrices[packaging];
  assertNonNegativeInt(pricePerBox, `packagingPrices.${packaging}`);

  const crabPerCopy = items.reduce((sum, it) => sum + it.priceCents * it.qty, 0);

  let boxes;
  let crabCents;
  if (copies === null || copies === undefined) {
    const totalCount = items.reduce((sum, it) => sum + it.qty, 0);
    boxes = boxesFor(totalCount);
    crabCents = crabPerCopy;
  } else {
    assertInt(copies, 'copies');
    if (copies <= 0) throw new Error(`copies must be > 0, got ${copies}`);
    boxes = copies;
    crabCents = crabPerCopy * copies;
  }

  const packagingCents = boxes * pricePerBox;
  return { crabCents, boxes, packagingCents, totalCents: crabCents + packagingCents };
}

/**
 * 费用分摊：先算精确值（totalCents × w_i ÷ W），再向下取整 floor；
 * 除不尽的分位余数**直接抹零**，由平台承担 —— 任何成员都不会多付。
 * 恒等保证（抹零口径）：Σ 结果 <= totalCents，且每个结果 <= 该成员的精确分摊值，
 * 差额 totalCents - Σ 结果 < weights.length（只丢分位，不会丢掉整元）。
 * 全部重量为 0 时按份数均分，同样抹零。
 */
export function allocateFreight(totalCents, weights) {
  assertNonNegativeInt(totalCents, 'totalCents');
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new Error('weights must be a non-empty array');
  }
  for (const [i, w] of weights.entries()) {
    assertNonNegativeInt(w, `weights[${i}]`);
  }

  const n = weights.length;
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  return totalWeight === 0
    ? weights.map(() => Math.floor(totalCents / n))
    : weights.map((w) => Math.floor((totalCents * w) / totalWeight));
}

/**
 * 运费 + 包装费合并均摊：两者相加成一份总额，按重量**一次性分完**（一次精确计算、一次 floor、
 * 一次抹零），不再分别均摊、也不再把余数补给前几名。
 *
 * 每条明细满足：packagingShareCents + freightShareCents === totalShareCents
 * （即该成员实际分摊到的那一份）；包装费行取包装费精确值的 floor，运费行为合并份额的余额，
 * 因此 Σ 包装费行 <= 包装费总额、Σ 合并份额 <= 运费 + 包装费总额，零头全部由平台承担。
 * freightCents 缺省为 0：团购未结单、运费未录入时只分摊包装费，不凭空造运费。
 */
export function allocatePackagingAndFreight({ packagingCents, freightCents = 0, weights }) {
  assertNonNegativeInt(packagingCents, 'packagingCents');
  assertNonNegativeInt(freightCents, 'freightCents');
  const totalShares = allocateFreight(packagingCents + freightCents, weights);
  const packagingShares = allocateFreight(packagingCents, weights);
  return totalShares.map((totalShareCents, i) => ({
    packagingShareCents: packagingShares[i],
    freightShareCents: totalShareCents - packagingShares[i],
    totalShareCents,
  }));
}

/**
 * 满减优惠码（活动券）：**后台可配置的限量活动** —— 取代原先硬编码的关键词券。
 *
 * 用户口径（2026-09-20）：
 *   - **一个活动码，所有用户共用**（不是一人一码）
 *   - 后台可配：活动码 / 门槛金额（满 X 元）/ 减免金额（减 Y 元）/ 总张数 N
 *   - 共 N 张 = 总共能用 N 次，**用完即止**（归 0 即结束，后台展示为「已结束」）
 *   - 计数**包含已取消 / 已退款（软删）的订单** —— 用掉就占名额、**不退回**
 *   - 后台「点击生效」之后用户才能用
 *
 * 规则（与旧券同口径的部分）：
 *   - 门槛按**蟹款**判定（**不含包装费、不含运费**）—— 运费是发货前才录的，含它没法在提交那一刻判定
 *   - 减免 = min(面额, 蟹款)，金额不会被减成负数
 *   - 券码必须来自**独立的券码输入框**，绝不从订单备注里读（备注是自由文本，会误触发）
 *   - 一单一券、拼团单不参与（拼团走另一条链路）
 *
 * 活动配置存 settings 表（见 configRepo 的 COUPON_KEYS / getCouponActivityState）；
 * 本函数只吃一份配置快照 + 已用次数，保持纯函数，可单测。
 */

/** 活动配置缺省值（settings 里没有对应行时的口径：等于没有活动）。 */
export const EMPTY_COUPON_ACTIVITY = Object.freeze({
  code: '',
  minCents: 0,
  discountCents: 0,
  total: 0,
  enabled: false,
});

/** 与 httpError 同形（statusCode + code），路由层错误处理器直接认这两个字段。 */
function couponError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * 券码 + 活动配置 + 蟹款 + 已用次数 → { couponCode, discountCents }。
 * 券码为空 → null（视为不用券）；其余情况要么给出结果，要么抛 4xx（**绝不静默忽略**）。
 *
 * 判定顺序（错误码是前端文案与测试的契约，别随手调换顺序）：
 *   ① 活动未配置 / 未启用 → 400 COUPON_INACTIVE（后台点「启用活动」之后才能用）
 *   ② 券码不匹配          → 400 COUPON_CODE_INVALID
 *   ③ 已用满 N 张         → 409 COUPON_SOLD_OUT（归 0 即结束）
 *   ④ 蟹款未达门槛        → 422 COUPON_MIN_NOT_MET
 *
 * @param {object} input
 * @param {object|null} input.activity { code, minCents, discountCents, total, enabled }
 * @param {string|null} input.code 用户输入的券码（独立输入框的值，不是备注）
 * @param {number} input.crabCents 订单蟹款合计（不含包装费、运费）
 * @param {number} [input.usedCount] 该活动码已用次数（含已取消/退款订单）
 */
export function resolveCouponActivity({ activity, code, crabCents, usedCount = 0 }) {
  assertNonNegativeInt(crabCents, 'crabCents');
  if (code === null || code === undefined) return null;
  const text = String(code).trim();
  if (text === '') return null;

  const config = activity ?? EMPTY_COUPON_ACTIVITY;
  if (!config.code || config.total <= 0) {
    throw couponError(400, 'COUPON_INACTIVE', '当前没有可用的满减优惠活动');
  }
  if (!config.enabled) {
    throw couponError(400, 'COUPON_INACTIVE', '满减优惠活动尚未生效，请等活动开启后再使用');
  }
  if (text !== config.code) {
    throw couponError(400, 'COUPON_CODE_INVALID', `优惠码「${text}」不正确，请核对后重新输入`);
  }
  if (usedCount >= config.total) {
    throw couponError(
      409,
      'COUPON_SOLD_OUT',
      `优惠码「${config.code}」已用完（共 ${config.total} 张，已用 ${usedCount} 张），活动已结束`,
    );
  }
  if (crabCents < config.minCents) {
    throw couponError(
      422,
      'COUPON_MIN_NOT_MET',
      `蟹款满 ${config.minCents / 100} 元才能使用「${config.code}」（当前蟹款 ${crabCents / 100} 元，不含包装费和运费）`,
    );
  }
  // 减免不超过蟹款：金额永远不会被减成负数。
  return { couponCode: config.code, discountCents: Math.min(config.discountCents, crabCents) };
}

/**
 * 截单校验：now >= cutoff 即视为已过截单时间（不可提交）。
 * 入参为 Date 或 UTC ISO 字符串。
 */
export function isAfterCutoff(nowUtc, cutoffUtc) {
  const now = nowUtc instanceof Date ? nowUtc : new Date(nowUtc);
  const cutoff = cutoffUtc instanceof Date ? cutoffUtc : new Date(cutoffUtc);
  if (Number.isNaN(now.getTime()) || Number.isNaN(cutoff.getTime())) {
    throw new Error('nowUtc and cutoffUtc must be valid dates');
  }
  return now.getTime() >= cutoff.getTime();
}
