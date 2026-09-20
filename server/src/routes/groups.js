import { requireUser } from '../plugins/auth.js';
import { isAfterCutoff, BOX_CAPACITY, allocateFreight, allocatePackagingAndFreight, specWeightGrams } from '../money.js';
import * as repo from '../repositories/groupRepo.js';
import { catalogBatchIds } from '../repositories/dailyBatchRepo.js';
import { isSpecOrderable } from '../repositories/configRepo.js';

/**
 * 拼团 API（全路径 /api/v1/groups...）。注册方：await app.register(groupRoutes)。
 * 团长最终提交复用 orderRepo.createOrder；该文件未就绪时可用 app.decorate('createOrder', fn) 注入替身。
 */

function fail(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function requireString(value, name, max = 200) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) {
    throw fail(422, 'VALIDATION_FAILED', `${name} 必须为 1-${max} 字字符串`);
  }
  return value.trim();
}

function requireQuantity(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw fail(422, 'INVALID_QUANTITY', '数量必须为 ≥1 的整数');
  }
  return value;
}

function loadGroup(db, token) {
  const group = repo.getGroupByToken(db, token);
  if (!group) throw fail(404, 'GROUP_NOT_FOUND', '拼团不存在');
  if (group.deleted_at) throw fail(404, 'GROUP_NOT_FOUND', '拼团已被团长撤销');
  return group;
}

function requireOpenGroup(group) {
  if (group.status !== 'open') {
    throw fail(409, 'GROUP_CLOSED', '拼团已结单，成员记录只读');
  }
}

function requireBeforeCutoff(db, group) {
  const batch = db.get('SELECT * FROM batches WHERE id = ?', group.batch_id);
  if (!batch || batch.status !== 'open' || isAfterCutoff(new Date(), batch.cutoff_time)) {
    throw fail(409, 'CUTOFF_PASSED', '已过截单时间');
  }
  return batch;
}

function requireValidSpec(db, group, specId) {
  if (!Number.isInteger(specId)) {
    throw fail(422, 'VALIDATION_FAILED', 'specId 必须为整数');
  }
  const spec = repo.getSpec(db, specId);
  if (!spec || !spec.active) {
    throw fail(422, 'SPEC_INVALID', '规格不存在或已下架');
  }
  if (spec.batch_id !== null && !catalogBatchIds(db, group.batch_id).includes(spec.batch_id)) {
    throw fail(422, 'SPEC_INVALID', '规格不属于当前批次');
  }
  if (!isSpecOrderable(spec)) {
    throw fail(422, 'SPEC_NOT_ORDERABLE', `${spec.gender === 'male' ? '公' : '母'}${spec.weight_label} 暂未开售或已缺货，请调整后重新提交`);
  }
  return spec;
}

function requireEditKey(request, member) {
  const key = request.headers['x-edit-key'];
  if (!key || typeof key !== 'string') {
    throw fail(403, 'EDIT_KEY_REQUIRED', '缺少编辑凭据 X-Edit-Key');
  }
  if (!member.edit_key || key !== member.edit_key) {
    throw fail(403, 'EDIT_KEY_INVALID', '编辑凭据不匹配，只能修改本人记录');
  }
}

function requireMemberItems(db, group, body) {
  const input = body.items === undefined
    ? [{ specId: body.specId, qty: body.quantity }]
    : body.items;
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    throw fail(422, 'VALIDATION_FAILED', 'items 必须为 1-100 项规格配置');
  }
  const bySpec = new Map();
  for (const item of input) {
    const qty = requireQuantity(item?.qty);
    const spec = requireValidSpec(db, group, item?.specId);
    const previous = bySpec.get(spec.id);
    const totalQty = requireQuantity((previous?.qty ?? 0) + qty);
    if (!Number.isSafeInteger(totalQty * spec.price_cents)) {
      throw fail(422, 'INVALID_QUANTITY', '采购数量过大');
    }
    bySpec.set(spec.id, { ...JSON.parse(repo.specSnapshotOf(spec)), qty: totalQty });
  }
  const items = [...bySpec.values()];
  requireQuantity(items.reduce((sum, item) => sum + item.qty, 0));
  if (!Number.isSafeInteger(items.reduce((sum, item) => sum + item.priceCents * item.qty, 0))) {
    throw fail(422, 'INVALID_QUANTITY', '采购金额过大');
  }
  return items;
}

function memberConfiguration(items) {
  return {
    specId: items[0].specId,
    specSnapshot: JSON.stringify({ items }),
    quantity: items.reduce((sum, item) => sum + item.qty, 0),
  };
}

function publicMember(member, items = repo.memberSnapshotItems(member)) {
  return {
    id: member.id, name: member.name, specId: member.spec_id,
    specLabel: repo.memberItemsLabel(items), quantity: member.quantity,
    items,
    crabCents: items.reduce((sum, item) => sum + item.priceCents * item.qty, 0),
  };
}

function estimateFor(db, summary, packaging = 'plain') {
  const prices = repo.getPackagingPrices(db);
  const boxes = summary.totalCount > 0
    ? Math.max(1, Math.ceil(summary.totalCount / BOX_CAPACITY))
    : 0;
  const packagingCents = boxes * prices[packaging];
  return {
    packaging,
    boxes,
    crabCents: summary.crabCents,
    packagingCents,
    totalCents: summary.crabCents + packagingCents,
  };
}

/**
 * 分摊权重 = 成员重量（克）：录过实重（发货称重）用实重，否则按成员历史规格快照的标重折算，
 * 与 fulfillmentRepo.recordGroupFreight 的分摊口径一致，保证用户端与管理端看到同一份分摊。
 * 成员规格无法识别重量时退回到按只数分摊 —— GET 接口不能因历史脏数据整体失败；
 * 权重全为 0（无实重且无标重）时由 allocateFreight 按份数均分兜底。
 */
function allocationWeights(summary) {
  const weights = summary.members.map((member) => {
    const actual = member.actual_weight_grams;
    if (Number.isInteger(actual) && actual >= 0) return actual;
    let grams = 0;
    for (const item of repo.memberSnapshotItems(member)) {
      const specGrams = specWeightGrams(item.weightLabel);
      const qty = Number(item.qty);
      if (specGrams === null || !Number.isSafeInteger(qty) || qty <= 0) return null;
      grams += specGrams * qty;
      if (!Number.isSafeInteger(grams)) return null;
    }
    return grams > 0 ? grams : null;
  });
  return weights.some((w) => w === null)
    ? summary.members.map((m) => m.quantity)
    : weights;
}

function groupAvailability(db, group, summary) {
  const batch = db.get('SELECT * FROM batches WHERE id = ?', group.batch_id);
  const afterCutoff = !batch || batch.status !== 'open'
    || isAfterCutoff(new Date(), batch.cutoff_time);
  return {
    cutoffTime: batch?.cutoff_time ?? null,
    isAfterCutoff: afterCutoff,
    canSubmit: summary.totalCount > 0
      && summary.totalCount % BOX_CAPACITY === 0
      && group.status === 'open'
      && !afterCutoff
      && summary.items.every(({ items }) => items.every((item) => isSpecOrderable(repo.getSpec(db, item.specId)))),
  };
}

export default async function routes(app) {
  const db = app.db;

  // 订单创建复用契约：orderRepo 就绪前允许测试注入 app.createOrder 替身
  let repoCreateOrder = null;
  try {
    ({ createOrder: repoCreateOrder } = await import('../repositories/orderRepo.js'));
  } catch {
    repoCreateOrder = null;
  }
  const resolveCreateOrder = () => app.createOrder ?? repoCreateOrder;

  // 创建拼团（调用者即团长）
  app.post('/api/v1/groups', async (request) => {
    const user = requireUser(request);
    const title = requireString(request.body?.title, 'title', 50);
    const batch = repo.getOpenBatch(db);
    if (!batch) throw fail(409, 'NO_OPEN_BATCH', '当前没有开放批次');
    const initial = request.body?.initialMember;
    const group = db.tx(() => {
      const created = repo.createGroup(db, {
        batchId: batch.id,
        leaderUserId: user.id,
        title,
        token: repo.generateToken(),
      });
      repo.insertAudit(db, {
        actorType: 'user', actorId: user.id, action: 'group.create',
        entity: 'groups', entityId: created.id, detail: { title, batchId: batch.id },
      });
      let member;
      let editKey;
      if (initial !== undefined) {
        requireBeforeCutoff(db, created);
        const name = requireString(initial?.name, 'name', 50);
        const items = requireMemberItems(db, created, initial ?? {});
        editKey = repo.generateEditKey();
        member = repo.addMember(db, {
          groupId: created.id, name, ...memberConfiguration(items), submittedOrder: 1, editKey,
        });
      }
      return { ...created, member, editKey };
    })();
    return {
      token: group.token, status: group.status,
      ...(group.member ? { member: publicMember(group.member), editKey: group.editKey } : {}),
    };
  });

  // 团长自己的团列表：发布后即可找回链接，结单后继续保留。
  app.get('/api/v1/groups/mine', async (request) => {
    const user = requireUser(request);
    return {
      groups: repo.listGroupsByLeader(db, user.id).map((group) => {
        const summary = repo.summarizeGroup(db, group);
        const estimated = estimateFor(db, summary);
        const order = group.submitted_order_id ? repo.getOrderById(db, group.submitted_order_id) : null;
        const crabCents = order?.crab_cents ?? summary.crabCents;
        const packagingCents = order?.packaging_cents ?? estimated.packagingCents;
        const freightCents = order?.freight_cents ?? null;
        return {
          id: group.id, token: group.token, title: group.title, status: group.status,
          batchId: group.batch_id, createdAt: group.created_at,
          ...groupAvailability(db, group, summary),
          totalCount: summary.totalCount, memberCount: summary.members.length,
          otherMemberCount: repo.countOtherMembers(db, group.id),
          orderNo: order?.order_no ?? null,
          amount: {
            phase: group.status === 'open' ? 'estimate' : 'final',
            crabCents, packagingCents, freightCents,
            totalCents: order?.total_cents ?? crabCents + packagingCents + (freightCents ?? 0),
          },
        };
      }),
    };
  });

  // 公开查看（链接即查看权），不含手机号和地址
  app.get('/api/v1/groups/:token', async (request) => {
    const group = loadGroup(db, request.params.token);
    const summary = repo.summarizeGroup(db, group);
    return {
      token: group.token,
      title: group.title,
      status: group.status,
      ...groupAvailability(db, group, summary),
      members: summary.items.map((it) => publicMember(it.member, it.items)),
      totalsBySpec: summary.totalsBySpec,
      totalCount: summary.totalCount,
      remainingToNextTen: summary.totalCount === 0
        ? BOX_CAPACITY
        : (BOX_CAPACITY - (summary.totalCount % BOX_CAPACITY)) % BOX_CAPACITY,
      estimated: estimateFor(db, summary),
    };
  });

  // 成员提交意向（公开，截单/结单后 409）
  app.post('/api/v1/groups/:token/members', async (request, reply) => {
    const group = loadGroup(db, request.params.token);
    requireOpenGroup(group);
    requireBeforeCutoff(db, group);
    const name = requireString(request.body?.name, 'name', 50);
    const items = requireMemberItems(db, group, request.body ?? {});
    const editKey = repo.generateEditKey();
    const member = db.tx(() => repo.addMember(db, {
      groupId: group.id,
      name,
      ...memberConfiguration(items),
      submittedOrder: repo.nextMemberOrder(db, group.id),
      editKey,
    }))();
    reply.code(201);
    return { member: publicMember(member), editKey };
  });

  // 成员修改自己的记录（凭 X-Edit-Key）
  app.put('/api/v1/groups/:token/members/:id', async (request) => {
    const group = loadGroup(db, request.params.token);
    requireOpenGroup(group);
    const member = repo.getMember(db, group.id, Number(request.params.id));
    if (!member) throw fail(404, 'MEMBER_NOT_FOUND', '成员记录不存在');
    requireEditKey(request, member);
    requireBeforeCutoff(db, group);

    const body = request.body ?? {};
    const hasField = ['name', 'items', 'specId', 'quantity'].some((k) => body[k] !== undefined);
    if (!hasField) throw fail(422, 'VALIDATION_FAILED', '至少提供 name/items/specId/quantity 之一');

    const name = body.name !== undefined ? requireString(body.name, 'name', 50) : member.name;
    const previousItems = repo.memberSnapshotItems(member);
    const changesLegacyConfig = body.specId !== undefined || body.quantity !== undefined;
    if (body.items === undefined && changesLegacyConfig && previousItems.length > 1) {
      throw fail(422, 'VALIDATION_FAILED', '混合配置请通过 items 修改每项规格和数量');
    }
    const items = requireMemberItems(db, group, body.items !== undefined
      ? { items: body.items }
      : changesLegacyConfig
        ? { specId: body.specId ?? member.spec_id, quantity: body.quantity ?? member.quantity }
        : { items: previousItems });

    const updated = repo.updateMember(db, {
      groupId: group.id,
      memberId: member.id,
      name,
      ...memberConfiguration(items),
    });
    return { member: publicMember(updated) };
  });

  // 成员删除自己的记录（凭 X-Edit-Key）
  app.delete('/api/v1/groups/:token/members/:id', async (request, reply) => {
    const group = loadGroup(db, request.params.token);
    requireOpenGroup(group);
    const member = repo.getMember(db, group.id, Number(request.params.id));
    if (!member) throw fail(404, 'MEMBER_NOT_FOUND', '成员记录不存在');
    requireEditKey(request, member);
    requireBeforeCutoff(db, group);
    repo.deleteMember(db, group.id, member.id);
    reply.code(204);
    return null;
  });

  // 团长撤销拼团（软删除）：无人参与可直接撤销；已有人参与由前端二次确认后再调。
  // 已提交的团连同订单一起撤销；已发货的订单不允许撤销。重复调用幂等返回 200。
  app.delete('/api/v1/groups/:token', async (request) => {
    const user = requireUser(request);
    const group = repo.getGroupByToken(db, request.params.token);
    if (!group) throw fail(404, 'GROUP_NOT_FOUND', '拼团不存在');
    if (group.deleted_at) {
      return { deleted: true, alreadyDeleted: true, revokedOrderNo: null };
    }
    if (group.leader_user_id !== user.id) {
      throw fail(403, 'NOT_GROUP_LEADER', '只有团长可以撤销这个拼团');
    }
    if (group.submitted_order_id) {
      const shipped = db.get(
        "SELECT 1 AS found FROM shipments WHERE order_id = ? AND status = 'shipped' LIMIT 1",
        group.submitted_order_id,
      );
      if (shipped) throw fail(409, 'GROUP_SHIPPED', '这个拼团已经发货，不能撤销');
    }
    return repo.softDeleteGroup(db, {
      groupId: group.id, reason: request.body?.reason ?? null, actorType: 'user', actorId: user.id,
    });
  });

  // 团长最终提交：生成正式订单（一笔订单 + 一个发货单）
  app.post('/api/v1/groups/:token/submit', async (request) => {
    const user = requireUser(request);
    const group = loadGroup(db, request.params.token);
    if (user.id !== group.leader_user_id) {
      throw fail(403, 'NOT_GROUP_LEADER', '只有团长可以提交团购订单');
    }
    const idempotencyKey = typeof request.body?.idempotencyKey === 'string'
      && request.body.idempotencyKey.trim().length > 0
      ? request.body.idempotencyKey.trim()
      : `group-submit-${group.token}`;

    if (group.status === 'submitted') {
      const existing = repo.findOrderByIdempotencyKey(db, idempotencyKey);
      if (existing && existing.id === group.submitted_order_id) {
        return { group, order: existing };
      }
      throw fail(409, 'GROUP_ALREADY_SUBMITTED', '拼团已提交');
    }
    if (group.status !== 'open') throw fail(409, 'GROUP_CLOSED', '拼团已关闭');

    const recipient = requireString(request.body?.recipient, 'recipient', 50);
    const phone = requireString(request.body?.phone, 'phone', 30);
    const address = requireString(request.body?.address, 'address', 300);
    const packaging = request.body?.packaging ?? 'plain';
    if (packaging !== 'plain' && packaging !== 'gift') {
      throw fail(422, 'VALIDATION_FAILED', 'packaging 必须为 plain 或 gift');
    }

    const summary = repo.summarizeGroup(db, group);
    if (summary.totalCount === 0 || summary.totalCount % BOX_CAPACITY !== 0) {
      throw fail(422, 'GROUP_NOT_READY', '总数必须大于 0 且为 10 的倍数');
    }
    requireBeforeCutoff(db, group);

    const createOrder = resolveCreateOrder();
    if (!createOrder) throw fail(503, 'ORDER_REPO_UNAVAILABLE', '订单创建服务未就绪');

    // 按规格聚合成员意向；gender/weightLabel 取自成员提交时的 spec_snapshot，
    // createOrder 写库时仍会按 specs 表重新定价并富化，这里保证快照字段齐全。
    const bySpec = new Map();
    for (const member of summary.items) {
      for (const item of member.items) {
        const entry = bySpec.get(item.specId) ?? {
          specId: item.specId, qty: 0, gender: item.gender, weightLabel: item.weightLabel,
        };
        entry.qty += item.qty;
        bySpec.set(item.specId, entry);
      }
    }
    const items = [...bySpec.values()];
    const key = idempotencyKey;

    // 拼团提交的幂等键必须只属于当前拼团。否则同一用户把另一个拼团的
    // key 复制过来，createOrder 会返回旧订单，随后被错误挂到当前拼团。
    const keyCollision = repo.findOrderByIdempotencyKey(db, key);
    if (keyCollision) {
      throw fail(409, 'IDEMPOTENCY_KEY_CONFLICT', '幂等键已被其他订单使用，请更换幂等键');
    }

    // 拼团成员意向是异构聚合（总量明细），不是"每份相同 × N 份"的套餐，
    // 因此走自定义模式（copies=null）：蟹款 = Σ price×qty，盒数 = boxesFor(总只数)。
    let order;
    let shipments;
    try {
      ({ order, shipments } = db.tx(() => {
        const result = createOrder(db, {
          batchId: group.batch_id,
          userId: user.id,
          source: 'group',
          idempotencyKey: key,
          shipments: [{ recipient, phone, address, packaging, copies: null, items }],
        });
        // 与正式订单在同一事务冻结成员价格，后续调价不能改写已结单的分账。
        for (const entry of summary.items) {
          repo.updateMember(db, {
            groupId: group.id, memberId: entry.member.id, name: entry.member.name,
            ...memberConfiguration(entry.items),
          });
        }
        repo.markGroupSubmitted(db, {
          groupId: group.id, orderId: result.order.id, recipient, phone, address,
        });
        repo.insertAudit(db, {
          actorType: 'user', actorId: user.id, action: 'group.submit',
          entity: 'groups', entityId: group.id,
          detail: { orderId: result.order.id, orderNo: result.order.order_no, totalCount: summary.totalCount, idempotencyKey: key },
        });
        return result;
      })());
    } catch (err) {
      if (err.code === 'CUTOFF_PASSED') throw fail(409, 'CUTOFF_PASSED', '已过截单时间');
      if (err.code === 'BELOW_TEN_NEEDS_CONFIRM') throw fail(422, 'GROUP_NOT_READY', err.message);
      throw err;
    }

    const updated = repo.getGroupById(db, group.id);
    return { group: updated, order, shipments };
  });

  // 金额构成：结单前按当前价估算；结单后按订单快照价 + 成员合并分摊（包装费 + 运费一次性分完）
  app.get('/api/v1/groups/:token/amount', async (request) => {
    const group = loadGroup(db, request.params.token);
    const summary = repo.summarizeGroup(db, group);
    const weights = allocationWeights(summary);
    const hasMembers = summary.members.length > 0;

    if (group.status === 'open') {
      const est = estimateFor(db, summary);
      // 未结单（无运费）时只分摊包装费，不凭空造运费。
      const pkgShares = hasMembers ? allocateFreight(est.packagingCents, weights) : [];
      return {
        phase: 'estimate',
        ...est,
        freightCents: null,
        members: summary.items.map((it, i) => ({
          ...publicMember(it.member, it.items),
          crabCents: it.crabCents,
          packagingShareCents: pkgShares[i],
          freightShareCents: null,
          totalCents: it.crabCents + pkgShares[i],
        })),
      };
    }

    // 结单后：以订单金额为总额口径；订单行缺失（如历史数据）按成员快照价兜底
    const order = group.submitted_order_id ? repo.getOrderById(db, group.submitted_order_id) : null;
    const snapCrab = summary.items.reduce(
      (sum, it) => sum + it.crabCents, 0,
    );
    const crabCents = order ? order.crab_cents : snapCrab;
    const packagingCents = order ? order.packaging_cents : estimateFor(db, summary).packagingCents;
    const freightCents = order ? order.freight_cents : null;

    // 运费 + 包装费合并成一份总额，一次性分完（除不尽抹零，平台承担）。
    // 运费未录入时只分摊包装费：包装费行即份额，运费行沿用已录入的成员分摊（通常为 null）。
    const feeLines = !hasMembers
      ? []
      : freightCents === null
        ? allocateFreight(packagingCents, weights).map((share) => ({
          packagingShareCents: share,
          freightShareCents: null,
          totalShareCents: share,
        }))
        : allocatePackagingAndFreight({ packagingCents, freightCents, weights });

    const members = summary.items.map((it, i) => {
      const crab = it.crabCents;
      const line = feeLines[i];
      const recordedFreight = it.member.freight_share_cents;
      // 人工改价优先：管理员明确指定的运费不再按比例重算，包装费行取合并份额的余额，
      // 使两项之和仍等于该成员分摊到的那一份（改价大于份额时以改价为准）。
      if (freightCents !== null && it.member.freight_adjusted === 1 && recordedFreight !== null) {
        const packagingShare = Math.max(0, line.totalShareCents - recordedFreight);
        return {
          ...publicMember(it.member, it.items),
          crabCents: crab,
          packagingShareCents: packagingShare,
          freightShareCents: recordedFreight,
          totalCents: crab + packagingShare + recordedFreight,
        };
      }
      const packagingShare = line.packagingShareCents;
      const freightShare = line.freightShareCents ?? recordedFreight ?? null;
      return {
        ...publicMember(it.member, it.items),
        crabCents: crab,
        packagingShareCents: packagingShare,
        freightShareCents: freightShare,
        totalCents: crab + packagingShare + (freightShare ?? 0),
      };
    });
    return {
      phase: 'final',
      orderId: order?.id ?? null,
      orderNo: order?.order_no ?? null,
      crabCents,
      packagingCents,
      freightCents: freightCents ?? null,
      totalCents: order?.total_cents ?? crabCents + packagingCents + (freightCents ?? 0),
      members,
    };
  });
}
