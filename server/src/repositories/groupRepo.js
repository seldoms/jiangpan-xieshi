import crypto from 'node:crypto';
import { DEFAULT_PACKAGING_PRICES } from '../money.js';

/**
 * 拼团 DAO：groups / group_members 的全部 SQL 收敛在此。
 * db 为 createDb() 返回的包装对象（all/get/run/tx）。
 */

export function generateToken() {
  return crypto.randomBytes(16).toString('base64url');
}

export function generateEditKey() {
  return crypto.randomBytes(16).toString('base64url');
}

export function specLabel(spec) {
  return `${spec.gender === 'male' ? '公' : '母'}${spec.weight_label}`;
}

export function getOpenBatch(db) {
  return db.get(
    "SELECT * FROM batches WHERE status = 'open' ORDER BY julianday(cutoff_time), id LIMIT 1",
  );
}

export function getGroupByToken(db, token) {
  return db.get('SELECT * FROM groups WHERE token = ?', token);
}

export function getGroupById(db, id) {
  return db.get('SELECT * FROM groups WHERE id = ?', id);
}

export function listGroupsByLeader(db, userId) {
  return db.all(
    'SELECT * FROM groups WHERE leader_user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC',
    userId,
  );
}

/**
 * 团长撤销拼团（软删除）：团打 deleted_at，已提交产生的订单同时软删（撤销）。
 * 成员记录与金额快照全部保留，便于事后追溯；两次操作都写审计。
 * 约定：团长自己的成员记录 submitted_order 恒为 1（创建团时必带 initialMember），
 * 因此「其他人」= 序号非 1 的成员。
 */
export function countOtherMembers(db, groupId) {
  const row = db.get(
    'SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND (submitted_order IS NULL OR submitted_order <> 1)',
    groupId,
  );
  return row.n;
}

export function softDeleteGroup(db, { groupId, reason = null, actorType = 'user', actorId = null }) {
  return db.tx(() => {
    const group = getGroupById(db, groupId);
    if (!group) throw new Error(`拼团 ${groupId} 不存在`);
    if (group.deleted_at) {
      return { id: group.id, token: group.token, deleted: true, alreadyDeleted: true, revokedOrderNo: null };
    }
    const now = new Date().toISOString();
    let revokedOrder = null;
    if (group.submitted_order_id) {
      const order = db.get('SELECT * FROM orders WHERE id = ?', group.submitted_order_id);
      if (order && !order.deleted_at) {
        db.run('UPDATE orders SET deleted_at = ? WHERE id = ?', now, order.id);
        insertAudit(db, {
          actorType, actorId, action: 'order.delete', entity: 'order', entityId: order.id,
          detail: { orderNo: order.order_no, reason, via: 'group.delete' },
        });
        revokedOrder = order;
      }
    }
    db.run('UPDATE groups SET deleted_at = ? WHERE id = ?', now, group.id);
    insertAudit(db, {
      actorType, actorId, action: 'group.delete', entity: 'groups', entityId: group.id,
      detail: { title: group.title, token: group.token, revokedOrderNo: revokedOrder?.order_no ?? null, reason },
    });
    return {
      id: group.id, token: group.token, deleted: true, alreadyDeleted: false,
      revokedOrderNo: revokedOrder?.order_no ?? null,
    };
  })();
}

export function createGroup(db, { batchId, leaderUserId, title, token }) {
  const now = new Date().toISOString();
  const info = db.run(
    'INSERT INTO groups (batch_id, leader_user_id, token, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    batchId, leaderUserId, token, title, 'open', now,
  );
  return getGroupById(db, info.lastInsertRowid);
}

export function getSpec(db, specId) {
  return db.get('SELECT * FROM specs WHERE id = ?', specId);
}

export function specSnapshotOf(spec) {
  return JSON.stringify({
    specId: spec.id,
    gender: spec.gender,
    weightLabel: spec.weight_label,
    label: specLabel(spec),
    priceCents: spec.price_cents,
  });
}

export function listMembers(db, groupId) {
  return db.all(
    'SELECT * FROM group_members WHERE group_id = ? ORDER BY submitted_order, id',
    groupId,
  );
}

export function getMember(db, groupId, memberId) {
  return db.get(
    'SELECT * FROM group_members WHERE group_id = ? AND id = ?',
    groupId, memberId,
  );
}

export function nextMemberOrder(db, groupId) {
  const row = db.get(
    'SELECT COALESCE(MAX(submitted_order), 0) + 1 AS next FROM group_members WHERE group_id = ?',
    groupId,
  );
  return row.next;
}

export function addMember(db, { groupId, name, specId, specSnapshot, quantity, submittedOrder, editKey }) {
  const now = new Date().toISOString();
  const info = db.run(
    `INSERT INTO group_members (group_id, name, spec_id, spec_snapshot, quantity, submitted_order, edit_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
     groupId, name, specId, specSnapshot, quantity, submittedOrder, editKey, now,
  );
  return getMember(db, groupId, info.lastInsertRowid);
}

export function updateMember(db, { groupId, memberId, name, specId, specSnapshot, quantity }) {
  db.run(
    `UPDATE group_members SET name = ?, spec_id = ?, spec_snapshot = ?, quantity = ?
     WHERE group_id = ? AND id = ?`,
     name, specId, specSnapshot, quantity, groupId, memberId,
  );
  return getMember(db, groupId, memberId);
}

export function deleteMember(db, groupId, memberId) {
  db.run('DELETE FROM group_members WHERE group_id = ? AND id = ?', groupId, memberId);
}

export function markGroupSubmitted(db, { groupId, orderId, recipient, phone, address }) {
  db.run(
    `UPDATE groups
     SET status = 'submitted', submitted_order_id = ?, address_recipient = ?, address_phone = ?, address = ?
     WHERE id = ?`,
     orderId, recipient, phone, address, groupId,
  );
  return getGroupById(db, groupId);
}

export function findOrderByIdempotencyKey(db, key) {
  return db.get('SELECT * FROM orders WHERE idempotency_key = ?', key);
}

export function getOrderById(db, id) {
  return db.get('SELECT * FROM orders WHERE id = ?', id);
}

/**
 * 包装价：settings 表（002 迁移）按 key 'packaging.plain' / 'packaging.gift' 存整数分；
 * 表或键缺失时兜底默认价。
 */
export function getPackagingPrices(db) {
  try {
    const plain = db.get("SELECT value FROM settings WHERE key = 'packaging.plain'");
    const gift = db.get("SELECT value FROM settings WHERE key = 'packaging.gift'");
    return {
      plain: plain && /^-?\d+$/.test(plain.value) ? Number(plain.value) : DEFAULT_PACKAGING_PRICES.plain,
      gift: gift && /^-?\d+$/.test(gift.value) ? Number(gift.value) : DEFAULT_PACKAGING_PRICES.gift,
    };
  } catch {
    return { ...DEFAULT_PACKAGING_PRICES };
  }
}

export function insertAudit(db, { actorType, actorId, action, entity, entityId, detail }) {
  db.run(
    'INSERT INTO audit_logs (actor_type, actor_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    actorType, actorId ?? null, action, entity, entityId ?? null,
    detail ? JSON.stringify(detail) : null, new Date().toISOString(),
  );
}

/** 兼容旧单规格快照；新记录用 items 保留成员的一整份混合配置。 */
export function memberSnapshotItems(member) {
  const snapshot = JSON.parse(member.spec_snapshot);
  return Array.isArray(snapshot.items)
    ? snapshot.items
    : [{ ...snapshot, specId: member.spec_id, qty: member.quantity }];
}

export function memberItemsLabel(items) {
  return items.length === 1
    ? items[0].label
    : items.map((item) => `${item.label} × ${item.qty}`).join(' + ');
}

/** 开团按现价估算；结单后保持最终提交时的成员价格快照。 */
export function summarizeGroup(db, group) {
  const members = listMembers(db, group.id);
  const bySpec = new Map();
  let totalCount = 0;
  let crabCents = 0;
  const items = members.map((member) => {
    const memberItems = memberSnapshotItems(member).map((snapshot) => {
      const spec = group.status === 'open' ? getSpec(db, snapshot.specId) : null;
      const item = spec
        ? { ...snapshot, ...JSON.parse(specSnapshotOf(spec)) }
        : snapshot;
      const entry = bySpec.get(item.specId) ?? { specId: item.specId, label: item.label, quantity: 0 };
      entry.quantity += item.qty;
      bySpec.set(item.specId, entry);
      totalCount += item.qty;
      crabCents += item.priceCents * item.qty;
      return item;
    });
    return {
      member,
      items: memberItems,
      label: memberItemsLabel(memberItems),
      crabCents: memberItems.reduce((sum, item) => sum + item.priceCents * item.qty, 0),
    };
  });
  return { members, items, totalsBySpec: [...bySpec.values()], totalCount, crabCents };
}
