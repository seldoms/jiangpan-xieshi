import { DEFAULT_PACKAGING_PRICES } from '../money.js';
import { catalogBatchIds, deliveryDate, ensureDailyBatch, inheritBatchCatalog } from './dailyBatchRepo.js';

const SPEC_COLUMNS = 'id, batch_id, gender, weight_label, price_cents, active, sold_out, sort';

function mapSpec(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    gender: row.gender,
    weightLabel: row.weight_label,
    priceCents: row.price_cents,
    active: row.active === 1,
    soldOut: row.sold_out === 1,
    sort: row.sort,
  };
}

export function listSpecs(db, { activeOnly = false } = {}) {
  const rows = db.all(
    `SELECT ${SPEC_COLUMNS} FROM specs ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, id`,
  );
  return rows.map(mapSpec);
}

export function listActiveSpecsForBatch(db, batchId) {
  const ids = catalogBatchIds(db, batchId);
  const rows = db.all(
    `SELECT ${SPEC_COLUMNS} FROM specs
     WHERE active = 1 AND (batch_id IS NULL OR batch_id IN (${ids.map(() => '?').join(',')}))
     ORDER BY sort, id`,
    ...ids,
  );
  return rows.map(mapSpec);
}

export function getSpec(db, id) {
  const row = db.get(`SELECT ${SPEC_COLUMNS} FROM specs WHERE id = ?`, id);
  return row ? mapSpec(row) : null;
}

export function nextSpecSort(db) {
  const row = db.get('SELECT MAX(sort) AS maxSort FROM specs');
  return (row?.maxSort ?? -1) + 1;
}

/** 未显式指定 sort 时排到末位。旧实现由前端写死 9999，是「顺序不生效」的根因之一。 */
export function createSpec(db, { batchId = null, gender, weightLabel, priceCents, active = true, soldOut = false, sort = null }) {
  const sortValue = sort == null ? nextSpecSort(db) : sort;
  const result = db.run(
    'INSERT INTO specs (batch_id, gender, weight_label, price_cents, active, sold_out, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
    batchId, gender, weightLabel, priceCents, active ? 1 : 0, soldOut ? 1 : 0, sortValue,
  );
  return getSpec(db, result.lastInsertRowid);
}

const SPEC_PATCH_COLUMNS = {
  batchId: 'batch_id',
  gender: 'gender',
  weightLabel: 'weight_label',
  priceCents: 'price_cents',
  active: 'active',
  soldOut: 'sold_out',
  sort: 'sort',
};

export function updateSpec(db, id, patch) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(SPEC_PATCH_COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    // active / soldOut 是布尔，落库要转 0/1
    const isBool = key === 'active' || key === 'soldOut';
    params.push(isBool ? (patch[key] ? 1 : 0) : patch[key]);
  }
  if (sets.length > 0) {
    db.run(`UPDATE specs SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }
  return getSpec(db, id);
}

export function specsExist(db, specIds) {
  if (specIds.length === 0) return true;
  const placeholders = specIds.map(() => '?').join(', ');
  const { count } = db.get(
    `SELECT COUNT(*) AS count FROM specs WHERE id IN (${placeholders})`,
    ...specIds,
  );
  return count === specIds.length;
}

/**
 * 规格引用统计：套餐模板条目 + 团购成员都硬引用 specs.id（两者都是 NOT NULL 外键），
 * 有引用时不能物理删除，只能停用（active=false）。
 */
export function countSpecReferences(db, specId) {
  const templateItems = db.get(
    'SELECT COUNT(*) AS count FROM package_template_items WHERE spec_id = ?', specId,
  ).count;
  const groupMembers = db.get(
    'SELECT COUNT(*) AS count FROM group_members WHERE spec_id = ?', specId,
  ).count;
  return { templateItems, groupMembers, total: templateItems + groupMembers };
}

/**
 * 物理删除规格 + 写审计。历史订单不受影响：orders.config_snapshot /
 * shipments.items_json / group_members.spec_snapshot 都已在各自时点落快照。
 * 调用方必须先做引用检查（见 countSpecReferences），否则会被外键约束拦下。
 */
export function deleteSpec(db, id, { actorId = null } = {}) {
  return db.tx(() => {
    const spec = getSpec(db, id);
    if (!spec) return null;
    db.run('DELETE FROM specs WHERE id = ?', id);
    db.run(
      'INSERT INTO audit_logs (actor_type, actor_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'admin', actorId ?? null, 'spec.delete', 'spec', id,
      JSON.stringify({
        batchId: spec.batchId, gender: spec.gender, weightLabel: spec.weightLabel,
        priceCents: spec.priceCents, active: spec.active,
      }),
      new Date().toISOString(),
    );
    return spec;
  })();
}

function listTemplateItems(db, templateId) {
  return db.all(
    `SELECT pti.spec_id, pti.quantity, s.gender, s.weight_label, s.price_cents
     FROM package_template_items pti
     JOIN specs s ON s.id = pti.spec_id
     WHERE pti.template_id = ?
     ORDER BY pti.id`,
    templateId,
  ).map((row) => ({
    specId: row.spec_id,
    gender: row.gender,
    weightLabel: row.weight_label,
    priceCents: row.price_cents,
    quantity: row.quantity,
  }));
}

function mapTemplate(db, row) {
  const items = listTemplateItems(db, row.id);
  return {
    id: row.id,
    name: row.name,
    packaging: row.packaging,
    active: row.active === 1,
    items,
    totalCount: items.reduce((sum, item) => sum + item.quantity, 0),
    crabCentsPerCopy: items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0),
  };
}

export function listTemplates(db, { activeOnly = false } = {}) {
  const rows = db.all(
    `SELECT id, name, packaging, active FROM package_templates ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`,
  );
  const stored = db.get("SELECT value FROM settings WHERE key = 'templates.order'");
  const order = stored ? JSON.parse(stored.value) : [];
  const positions = new Map(order.map((id, index) => [id, index]));
  return rows.sort((a, b) => (positions.get(a.id) ?? order.length) - (positions.get(b.id) ?? order.length) || a.id - b.id)
    .map((row) => mapTemplate(db, row));
}

export function getTemplate(db, id) {
  const row = db.get('SELECT id, name, packaging, active FROM package_templates WHERE id = ?', id);
  return row ? mapTemplate(db, row) : null;
}

export function templateNameExists(db, name, excludeId = null) {
  const row = excludeId === null
    ? db.get('SELECT id FROM package_templates WHERE name = ?', name)
    : db.get('SELECT id FROM package_templates WHERE name = ? AND id != ?', name, excludeId);
  return Boolean(row);
}

export function createTemplate(db, { name, packaging, active = true, items }) {
  return db.tx(() => {
    const result = db.run(
      'INSERT INTO package_templates (name, packaging, active, created_at) VALUES (?, ?, ?, ?)',
      name, packaging, active ? 1 : 0, new Date().toISOString(),
    );
    const templateId = result.lastInsertRowid;
    for (const item of items) {
      db.run(
        'INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (?, ?, ?)',
        templateId, item.specId, item.quantity,
      );
    }
    return getTemplate(db, templateId);
  })();
}

export function updateTemplate(db, id, { name, packaging, items }) {
  return db.tx(() => {
    if (name !== undefined || packaging !== undefined) {
      const current = db.get('SELECT name, packaging FROM package_templates WHERE id = ?', id);
      db.run(
        'UPDATE package_templates SET name = ?, packaging = ? WHERE id = ?',
        name ?? current.name, packaging ?? current.packaging, id,
      );
    }
    if (items !== undefined) {
      db.run('DELETE FROM package_template_items WHERE template_id = ?', id);
      for (const item of items) {
        db.run(
          'INSERT INTO package_template_items (template_id, spec_id, quantity) VALUES (?, ?, ?)',
          id, item.specId, item.quantity,
        );
      }
    }
    return getTemplate(db, id);
  })();
}

export function setTemplateActive(db, id, active) {
  db.run('UPDATE package_templates SET active = ? WHERE id = ?', active ? 1 : 0, id);
  return getTemplate(db, id);
}

function mapBatch(row) {
  return {
    id: row.id,
    name: row.name,
    cutoffTime: row.cutoff_time,
    deliveryDate: deliveryDate(row.cutoff_time),
    status: row.status,
    createdAt: row.created_at,
  };
}

export function listBatches(db) {
  return db.all('SELECT * FROM batches ORDER BY id DESC').map(mapBatch);
}

export function getBatch(db, id) {
  const row = db.get('SELECT * FROM batches WHERE id = ?', id);
  return row ? mapBatch(row) : null;
}

export function getCurrentBatch(db) {
  const row = db.get(
    "SELECT * FROM batches WHERE status = 'open' ORDER BY julianday(cutoff_time), id LIMIT 1",
  );
  return row ? mapBatch(row) : null;
}

export function batchNameExists(db, name) {
  return Boolean(db.get('SELECT id FROM batches WHERE name = ?', name));
}

export function batchDateExists(db, cutoffTime, excludeId = null) {
  const date = deliveryDate(cutoffTime);
  return Boolean(db.get("SELECT id FROM batches WHERE date(cutoff_time, '+8 hours') = ? AND (? IS NULL OR id != ?)", date, excludeId, excludeId));
}

export function createBatch(db, { name, cutoffTime }) {
  return db.tx(() => {
    if (batchDateExists(db, cutoffTime)) {
      throw Object.assign(new Error('该配送日期已有批次，请编辑已有批次'), { statusCode: 409, code: 'BATCH_DATE_CONFLICT' });
    }
    const source = getCurrentBatch(db) ?? db.get('SELECT id FROM batches ORDER BY id DESC LIMIT 1');
    const result = db.run(
      'INSERT INTO batches (name, cutoff_time, status, created_at) VALUES (?, ?, ?, ?)',
      name, cutoffTime, 'open', new Date().toISOString(),
    );
    if (source) inheritBatchCatalog(db, source.id, Number(result.lastInsertRowid));
    return getBatch(db, result.lastInsertRowid);
  }).immediate();
}

export function closeBatch(db, id) {
  return db.tx(() => {
    db.run("UPDATE batches SET status = 'closed' WHERE id = ?", id);
    ensureDailyBatch(db);
    return getBatch(db, id);
  }).immediate();
}

export function updateBatch(db, id, { name, cutoffTime }) {
  return db.tx(() => {
    const current = getBatch(db, id);
    if (!current || current.status !== 'open') {
      throw Object.assign(new Error('已截单批次不能修改'), { statusCode: 409, code: 'BATCH_CLOSED' });
    }
    if (cutoffTime !== undefined && batchDateExists(db, cutoffTime, id)) {
      throw Object.assign(new Error('该配送日期已有批次，请编辑已有批次'), { statusCode: 409, code: 'BATCH_DATE_CONFLICT' });
    }
    db.run('UPDATE batches SET name = ?, cutoff_time = ? WHERE id = ?', name ?? current.name, cutoffTime ?? current.cutoffTime, id);
    return getBatch(db, id);
  }).immediate();
}

export function reorderCatalog(db, kind, ids) {
  return db.tx(() => {
    const table = kind === 'specs' ? 'specs' : 'package_templates';
    const existing = db.all(`SELECT id FROM ${table}`);
    if (existing.length !== ids.length || existing.some((row) => !ids.includes(row.id))) return false;
    if (kind === 'specs') {
      ids.forEach((id, index) => db.run('UPDATE specs SET sort = ? WHERE id = ?', index, id));
    } else {
      setSetting(db, 'templates.order', JSON.stringify(ids));
    }
    return true;
  }).immediate();
}

/**
 * 一键置顶：按「公母分组 + 价格从高到低」重排全部规格，写回连续 sort。
 * 口径 = 高品质（贵）的排在前面；同价按 id 稳定排序。
 * 前台价目表按 gender 分组渲染，组内保持这里写的顺序，所以贵的自然在最上面。
 */
export function autoSortSpecs(db) {
  const rows = db.all('SELECT id, gender, price_cents FROM specs');
  const ordered = [...rows].sort((a, b) => {
    if (a.gender !== b.gender) return a.gender === 'male' ? -1 : 1;
    const diff = b.price_cents - a.price_cents;
    return diff !== 0 ? diff : a.id - b.id;
  });
  return db.tx(() => {
    ordered.forEach((row, index) => db.run('UPDATE specs SET sort = ? WHERE id = ?', index, row.id));
    return listSpecs(db);
  }).immediate();
}

function parseSettingValue(value) {
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

export function listSettings(db) {
  const rows = db.all('SELECT key, value FROM settings ORDER BY key');
  const settings = {};
  for (const row of rows) settings[row.key] = parseSettingValue(row.value);
  return settings;
}

export function setSetting(db, key, value) {
  db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, String(value),
  );
}

export function getShareBaseUrl(db) {
  return db.get("SELECT value FROM settings WHERE key = 'share.site_url'")?.value ?? '';
}

export function getPackagingPrices(db) {
  const rows = db.all(
    "SELECT key, value FROM settings WHERE key IN ('packaging.plain', 'packaging.gift')",
  );
  const stored = {};
  for (const row of rows) {
    const parsed = /^-?\d+$/.test(row.value) ? Number(row.value) : null;
    if (parsed !== null) stored[row.key] = parsed;
  }
  return {
    plain: stored['packaging.plain'] ?? DEFAULT_PACKAGING_PRICES.plain,
    gift: stored['packaging.gift'] ?? DEFAULT_PACKAGING_PRICES.gift,
  };
}

export function findUserByOrderCode(db, orderCode) {
  return db.get('SELECT * FROM users WHERE order_code = ? COLLATE NOCASE', orderCode) ?? null;
}

/**
 * 公蟹开卖时间：北京时间 2026-10-01 00:00。此前公蟹只展示、不可下单。
 * 配置展示、拼团意向和正式下单共用同一判定。
 */
export const MALE_ORDERABLE_FROM = '2026-10-01T00:00:00+08:00';
const MALE_ORDERABLE_FROM_MS = Date.parse(MALE_ORDERABLE_FROM);

export function isSpecOrderable(spec, now = new Date()) {
  if (!spec || spec.active === false || spec.active === 0) return false;
  // 缺货优先：无论公母、无论日期，标了缺货就不可下单
  if (spec.soldOut === true || spec.sold_out === 1) return false;
  if (spec.gender !== 'male') return true;
  return now.getTime() >= MALE_ORDERABLE_FROM_MS;
}

/** config/current 的 specs 用：附加 orderable 供前端置灰。 */
export function withOrderable(specs, now = new Date()) {
  return specs.map((spec) => ({ ...spec, orderable: isSpecOrderable(spec, now) }));
}

// 公告存 settings 表（key/value），三个 key 各自一行。
export const NOTICE_KEYS = {
  content: 'notice.content',
  activeFrom: 'notice.active_from',
  activeUntil: 'notice.active_until',
};

function rawSetting(db, key) {
  return db.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}

/** 落库态（不做生效判定），PUT 响应与排查用。 */
export function getNotice(db) {
  return {
    content: rawSetting(db, NOTICE_KEYS.content) ?? '',
    activeFrom: rawSetting(db, NOTICE_KEYS.activeFrom),
    activeUntil: rawSetting(db, NOTICE_KEYS.activeUntil),
  };
}

/**
 * 生效中的公告：content 非空 且 now >= activeFrom 且（activeUntil 为空 或 now <= activeUntil）。
 * 任一条件不满足返回 null（前端据此不显示横幅）。
 */
export function getActiveNotice(db, now = new Date()) {
  const { content, activeFrom, activeUntil } = getNotice(db);
  const text = content.trim();
  if (!text) return null;
  const t = now.getTime();
  const from = activeFrom ? Date.parse(activeFrom) : NaN;
  const until = activeUntil ? Date.parse(activeUntil) : NaN;
  if (Number.isFinite(from) && t < from) return null;
  if (Number.isFinite(until) && t > until) return null;
  return { content: text, activeFrom: activeFrom ?? null, activeUntil: activeUntil ?? null };
}

function writeNullableSetting(db, key, value) {
  if (value === null || value === undefined || value === '') {
    db.run('DELETE FROM settings WHERE key = ?', key);
    return;
  }
  setSetting(db, key, value);
}

export function setNotice(db, { content = '', activeFrom = null, activeUntil = null }) {
  return db.tx(() => {
    writeNullableSetting(db, NOTICE_KEYS.content, content);
    writeNullableSetting(db, NOTICE_KEYS.activeFrom, activeFrom);
    writeNullableSetting(db, NOTICE_KEYS.activeUntil, activeUntil);
    return getNotice(db);
  })();
}


/* ---------------- 满减优惠码活动（后台可配置，取代旧的关键词券） ----------------
   存 settings 表（key/value），五个 key 各一行 —— 与包装置价、公告同一套模式。
   为什么不走 PUT /admin/settings：那个接口只收整数分，而活动码是字符串；
   而且在那边能单独改总量绕过活动码校验，容易造出半套配置。 */

export const COUPON_KEYS = {
  code: 'coupon.activity.code',
  minCents: 'coupon.activity.min_cents',
  discountCents: 'coupon.activity.discount_cents',
  total: 'coupon.activity.total',
  enabled: 'coupon.activity.enabled',
};

function intSetting(db, key) {
  const raw = rawSetting(db, key);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isInteger(parsed) ? parsed : 0;
}

/** 落库态配置（不做生效判定），排查与管理端回显用。 */
export function getCouponActivity(db) {
  return {
    code: rawSetting(db, COUPON_KEYS.code) ?? '',
    minCents: intSetting(db, COUPON_KEYS.minCents),
    discountCents: intSetting(db, COUPON_KEYS.discountCents),
    total: intSetting(db, COUPON_KEYS.total),
    enabled: rawSetting(db, COUPON_KEYS.enabled) === '1',
  };
}

/**
 * 活动码的**已用次数** —— 显式**不过滤 deleted_at**。
 *
 * 本平台的「取消订单」是软删（orders.deleted_at），而需求明确：取消、退款也占名额、**不退回**。
 * 所以这里刻意不写 `deleted_at IS NULL` —— 请勿「顺手补上」，那会直接把需求第 5 条改坏。
 */
export function countCouponUsage(db, code) {
  if (typeof code !== 'string' || code === '') return 0;
  return db.get('SELECT COUNT(*) AS c FROM orders WHERE coupon_code = ?', code).c;
}

/**
 * 活动完整状态（管理端 / 用户端共用一份口径）：
 *   configured  配置齐了（活动码非空 且 总量 > 0）
 *   used        已用张数（含已取消/退款订单）
 *   remaining   剩余张数 = max(0, total - used)
 *   active      生效中 = 已配置 && 后台已启用 && 还有剩余（前端只认这个）
 *   ended       已结束 = 已配置 && 后台已启用 && 剩余为 0（归 0 即结束）
 */
export function getCouponActivityState(db) {
  const activity = getCouponActivity(db);
  const used = countCouponUsage(db, activity.code);
  const remaining = Math.max(0, activity.total - used);
  const configured = activity.code !== '' && activity.total > 0;
  return {
    ...activity,
    configured,
    used,
    remaining,
    active: configured && activity.enabled && remaining > 0,
    ended: configured && activity.enabled && remaining === 0,
  };
}

/** 覆盖写入活动配置（活动码为空 = 撤下活动）。总量/门槛/面额都是整数分口径。 */
export function setCouponActivity(db, { code, minCents, discountCents, total, enabled }) {
  return db.tx(() => {
    writeNullableSetting(db, COUPON_KEYS.code, code);
    setSetting(db, COUPON_KEYS.minCents, minCents);
    setSetting(db, COUPON_KEYS.discountCents, discountCents);
    setSetting(db, COUPON_KEYS.total, total);
    setSetting(db, COUPON_KEYS.enabled, enabled ? '1' : '0');
    return getCouponActivityState(db);
  })();
}

/** 只切「生效 / 停用」开关，不动已配好的门槛、面额、总量。 */
export function setCouponActivityEnabled(db, enabled) {
  setSetting(db, COUPON_KEYS.enabled, enabled ? '1' : '0');
  return getCouponActivityState(db);
}
