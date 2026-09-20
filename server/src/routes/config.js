import { BOX_CAPACITY, isAfterCutoff } from '../money.js';
import { requireAdmin, findAdminByOrderCode, requireAdminRole, currentSession } from '../plugins/auth.js';
import { readCookie, buildSessionCookie, buildClearedCookie } from '../cookies.js';
import { createSession, deleteSession } from '../repositories/sessionRepo.js';
import { displayNameFromOrderCode, normalizeOrderCode, validateOrderCode } from '../orderCode.js';
import * as repo from '../repositories/configRepo.js';
import { touchLastLogin } from '../repositories/userRepo.js';

function fail(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * 下单码校验通过后签发 HttpOnly 会话票据：浏览器从此不再需要长期保存下单码。
 * 票据走 cookie，响应体不含它，前端 JS 也读不到。
 */
function issueSession(request, reply, { actorType, actorId }) {
  const config = request.server.config;
  const { token } = createSession(request.server.db, {
    actorType, actorId, ttlDays: config.sessionTtlDays,
  });
  reply.header('set-cookie', buildSessionCookie(config.sessionCookieName, token, {
    maxAgeSeconds: config.sessionTtlDays * 24 * 3600,
    secure: config.sessionCookieSecure,
  }));
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(400, 'VALIDATION_ERROR', `${field} 必须是非空字符串`);
  }
  return value.trim();
}

function requireNonNegativeInt(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw fail(422, 'VALIDATION_ERROR', `${field} 必须是非负整数（单位：分）`);
  }
  return value;
}

function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw fail(422, 'VALIDATION_ERROR', `${field} 必须是正整数`);
  }
  return value;
}

/** 公告时间：必须是可被 Date.parse 解析的非空字符串（保留原样回显，不强行转 ISO）。 */
function requireDateString(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value.trim()))) {
    throw fail(422, 'NOTICE_TIME_INVALID', `${field} 必须是有效的日期时间字符串`);
  }
  return value.trim();
}

function validateSpecPayload(db, body, { partial = false } = {}) {
  const patch = {};
  if (!partial || body.gender !== undefined) {
    if (body.gender !== 'male' && body.gender !== 'female') {
      throw fail(422, 'SPEC_GENDER_INVALID', 'gender 必须是 male 或 female');
    }
    patch.gender = body.gender;
  }
  if (!partial || body.weightLabel !== undefined) {
    patch.weightLabel = requireString(body.weightLabel, 'weightLabel');
  }
  if (!partial || body.priceCents !== undefined) {
    patch.priceCents = requireNonNegativeInt(body.priceCents, 'priceCents');
  }
  if (body.batchId !== undefined) {
    if (body.batchId !== null) {
      requirePositiveInt(body.batchId, 'batchId');
      if (!repo.getBatch(db, body.batchId)) {
        throw fail(422, 'SPEC_BATCH_INVALID', `批次 ${body.batchId} 不存在`);
      }
    }
    patch.batchId = body.batchId;
  }
  if (body.sort !== undefined) {
    if (!Number.isInteger(body.sort)) {
      throw fail(422, 'VALIDATION_ERROR', 'sort 必须是整数');
    }
    patch.sort = body.sort;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') {
      throw fail(422, 'VALIDATION_ERROR', 'active 必须是布尔值');
    }
    patch.active = body.active;
  }
  // 缺货开关：与 active 不同 —— 缺货是「看得见但买不了」，active=false 是「看不见」
  if (body.soldOut !== undefined) {
    if (typeof body.soldOut !== 'boolean') {
      throw fail(422, 'VALIDATION_ERROR', 'soldOut 必须是布尔值');
    }
    patch.soldOut = body.soldOut;
  }
  return patch;
}

function validateTemplateItems(db, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw fail(422, 'TEMPLATE_ITEMS_INVALID', 'items 必须是非空数组');
  }
  const seen = new Set();
  const normalized = items.map((item, i) => {
    const specId = requirePositiveInt(item?.specId, `items[${i}].specId`);
    const quantity = requirePositiveInt(item?.quantity, `items[${i}].quantity`);
    if (seen.has(specId)) {
      throw fail(422, 'TEMPLATE_ITEMS_INVALID', `规格 ${specId} 在 items 中重复`);
    }
    seen.add(specId);
    return { specId, quantity };
  });
  if (!repo.specsExist(db, [...seen])) {
    throw fail(422, 'TEMPLATE_SPEC_INVALID', 'items 引用了不存在的规格');
  }
  const total = normalized.reduce((sum, item) => sum + item.quantity, 0);
  if (total !== BOX_CAPACITY) {
    throw fail(422, 'PACKAGE_TOTAL_INVALID', `每份合计必须为 ${BOX_CAPACITY} 只，当前为 ${total} 只`);
  }
  return normalized;
}

function validatePackaging(value) {
  if (value !== 'plain' && value !== 'gift') {
    throw fail(422, 'PACKAGING_INVALID', 'packaging 必须是 plain 或 gift');
  }
  return value;
}

function validateShareBaseUrl(value) {
  if (value === '') return '';
  const invalid = () => fail(422, 'SHARE_URL_INVALID', '分享地址须为可访问的 http(s) 站点地址，不含路径、参数或账号密码');
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\?#@]/.test(value)
      || !/^https?:\/\/[^/]+\/?$/i.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain'
      || /^127\./.test(host) || host === '0.0.0.0' || host === '[::1]' || host === '[::]'
      || (!host.includes('.') && !host.startsWith('['))) throw invalid();
  return url.origin;
}

/**
 * 满减优惠码活动配置校验（后台可配）。
 *
 * 口径（用户 2026-09-20）：
 *   · 活动码为空串 = 撤下活动（门槛/面额/张数原样保留，方便下次原样恢复）
 *   · 活动码非空时：总张数必须 > 0（**共 N 张 = 总共能用 N 次**）、减免必须 > 0
 *   · 金额一律整数分；门槛按**蟹款**判定（不含包装费、运费）
 *   · enabled 默认 false —— 「点击生效」是独立动作，保存配置不等于上线
 */
function validateCouponActivityPayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw fail(400, 'VALIDATION_ERROR', '请求体必须是配置对象');
  }
  let code = '';
  if (body.code !== undefined && body.code !== null) {
    if (typeof body.code !== 'string') {
      throw fail(422, 'COUPON_CODE_INVALID', '活动码必须是字符串');
    }
    code = body.code.trim();
  }
  if (code !== '' && !/^\S{1,32}$/.test(code)) {
    throw fail(422, 'COUPON_CODE_INVALID', '活动码只能是 1-32 个字符，且不能包含空格');
  }
  const minCents = requireNonNegativeInt(body.minCents ?? 0, 'minCents');
  const discountCents = requireNonNegativeInt(body.discountCents ?? 0, 'discountCents');
  const total = requireNonNegativeInt(body.total ?? 0, 'total');
  if (code !== '') {
    if (total < 1) {
      throw fail(422, 'COUPON_TOTAL_INVALID', '总张数必须大于 0：共 N 张 = 总共能用 N 次');
    }
    if (discountCents < 1) {
      throw fail(422, 'COUPON_DISCOUNT_INVALID', '减免金额必须大于 0');
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw fail(422, 'VALIDATION_ERROR', 'enabled 必须是布尔值');
  }
  return { code, minCents, discountCents, total, enabled: body.enabled === true };
}

export default async function routes(app) {
  const { db } = app;

  app.get('/api/v1/config/current', async () => {
    const packagingPrices = repo.getPackagingPrices(db);
    const shareBaseUrl = repo.getShareBaseUrl(db);
    // 满减优惠码活动：公开只读（一个活动码所有用户共用，不是秘密；用于前端结算预览）。
    // 真正算钱与「用满 N 张」判定一律以后端 createOrder 为准。
    const coupon = repo.getCouponActivityState(db);
    const batch = repo.getCurrentBatch(db);
    if (!batch) {
      return { batch: null, specs: [], templates: [], packagingPrices, shareBaseUrl, coupon };
    }
    return {
      batch: {
        id: batch.id,
        name: batch.name,
        cutoffTime: batch.cutoffTime,
        deliveryDate: batch.deliveryDate,
        isAfterCutoff: isAfterCutoff(new Date(), batch.cutoffTime),
      },
      specs: repo.withOrderable(repo.listActiveSpecsForBatch(db, batch.id)),
      templates: repo.listTemplates(db, { activeOnly: true }),
      packagingPrices,
      shareBaseUrl,
      coupon,
    };
  });

  // 公告：公开接口，未生效时返回 null，前端据此决定是否渲染横幅。
  app.get('/api/v1/config/notice', async () => ({ notice: repo.getActiveNotice(db) }));

  app.post('/api/v1/auth/login', async (request, reply) => {
    const orderCode = request.body?.orderCode;
    if (typeof orderCode !== 'string' || orderCode.length === 0) {
      throw fail(400, 'ORDER_CODE_REQUIRED', '缺少下单码');
    }
    const formatError = validateOrderCode(orderCode);
    if (formatError) {
      throw fail(400, 'ORDER_CODE_INVALID_FORMAT', formatError);
    }
    const code = normalizeOrderCode(orderCode);
    const admin = findAdminByOrderCode(db, code);
    if (admin) {
      requireAdminRole(admin);
      issueSession(request, reply, { actorType: 'admin', actorId: admin.id });
      return { user: { id: admin.id, displayName: admin.name, role: admin.role } };
    }
    let user = repo.findUserByOrderCode(db, code);
    if (!user) {
      try {
        db.run(
          "INSERT INTO users (order_code, display_name, status, created_at) VALUES (?, ?, 'active', ?)",
          code,
          displayNameFromOrderCode(code),
          new Date().toISOString(),
        );
      } catch (error) {
        // 并发首次登录同一个码时，唯一约束命中后重新读取即可。
        if (!String(error?.message ?? '').includes('UNIQUE')) throw error;
      }
      user = repo.findUserByOrderCode(db, code);
    }
    if (!user) throw fail(500, 'ORDER_CODE_CREATE_FAILED', '下单码创建失败，请稍后重试');
    if (user.deleted_at) {
      throw fail(403, 'ORDER_CODE_DELETED', '该账号已被删除，请联系管理员');
    }
    if (user.status !== 'active') {
      throw fail(403, 'ORDER_CODE_DISABLED', '下单码已停用，请联系管理员');
    }
    touchLastLogin(db, user.id);
    issueSession(request, reply, { actorType: 'user', actorId: user.id });
    return { user: { id: user.id, displayName: user.display_name, role: 'user' } };
  });

  // 当前会话：前端启动时用它判断「还登录着吗」，有会话就不必再存下单码。
  app.get('/api/v1/auth/me', async (request) => {
    const session = currentSession(request);
    if (!session) throw fail(401, 'SESSION_REQUIRED', '登录状态已失效，请重新输入下单码');
    if (session.actor_type === 'admin') {
      const admin = db.get('SELECT * FROM admin_users WHERE id = ?', session.actor_id);
      if (!admin) throw fail(401, 'SESSION_REQUIRED', '登录状态已失效，请重新输入下单码');
      requireAdminRole(admin);
      return { user: { id: admin.id, displayName: admin.name, role: admin.role } };
    }
    const user = db.get('SELECT * FROM users WHERE id = ?', session.actor_id);
    if (!user) throw fail(401, 'SESSION_REQUIRED', '登录状态已失效，请重新输入下单码');
    if (user.deleted_at) throw fail(403, 'ORDER_CODE_DELETED', '该账号已被删除，请联系管理员');
    if (user.status !== 'active') throw fail(403, 'ORDER_CODE_DISABLED', '下单码已停用，请联系管理员');
    return { user: { id: user.id, displayName: user.display_name, role: 'user' } };
  });

  // 登出：吊销票据并清 cookie；重复调用也返回成功（幂等）。
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const name = request.server.config.sessionCookieName;
    const token = readCookie(request, name);
    if (token) deleteSession(db, token);
    reply.header('set-cookie', buildClearedCookie(name));
    return { ok: true };
  });

  app.get('/api/v1/admin/specs', async (request) => {
    requireAdmin(request);
    return { specs: repo.listSpecs(db) };
  });

  for (const kind of ['specs', 'package-templates']) {
    app.put(`/api/v1/admin/${kind}/reorder`, async (request) => {
      requireAdmin(request);
      const ids = request.body?.ids;
      if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
        throw fail(422, 'SORT_IDS_INVALID', 'ids 必须为不重复的正整数列表');
      }
      if (!repo.reorderCatalog(db, kind, ids)) {
        throw fail(409, 'CATALOG_CHANGED', '配置列表已变化，请刷新后重新排序');
      }
      return kind === 'specs' ? { specs: repo.listSpecs(db) } : { templates: repo.listTemplates(db) };
    });
  }

  // 一键归位：按「公母分组 + 重量升序」重排。新建规格会排到末位、拖拽也可能拖乱，用这个恢复标准顺序。
  app.post('/api/v1/admin/specs/auto-sort', async (request) => {
    requireAdmin(request);
    return { specs: repo.autoSortSpecs(db) };
  });

  app.post('/api/v1/admin/specs', async (request, reply) => {
    requireAdmin(request);
    const patch = validateSpecPayload(db, request.body ?? {});
    const spec = repo.createSpec(db, patch);
    reply.code(201);
    return { spec };
  });

  app.put('/api/v1/admin/specs/:id', async (request) => {
    requireAdmin(request);
    const id = Number(request.params.id);
    if (!repo.getSpec(db, id)) throw fail(404, 'SPEC_NOT_FOUND', `规格 ${request.params.id} 不存在`);
    const patch = validateSpecPayload(db, request.body ?? {}, { partial: true });
    return { spec: repo.updateSpec(db, id, patch) };
  });

  // 删除规格：先查引用（套餐模板条目 / 团购成员都是 NOT NULL 外键），
  // 有引用只能停用不能删；无引用才物理删 + 写审计。历史订单走各自快照，无需额外处理。
  app.delete('/api/v1/admin/specs/:id', async (request) => {
    const admin = requireAdmin(request);
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id <= 0 || !repo.getSpec(db, id)) {
      throw fail(404, 'SPEC_NOT_FOUND', `规格 ${request.params.id} 不存在`);
    }
    const refs = repo.countSpecReferences(db, id);
    if (refs.total > 0) {
      throw fail(
        409,
        'SPEC_IN_USE',
        `该规格已被 ${refs.total} 个套餐/团购引用，请先解除引用，或改用停用`,
      );
    }
    const spec = repo.deleteSpec(db, id, { actorId: admin?.id ?? null });
    return { deleted: true, spec, references: refs };
  });

  app.get('/api/v1/admin/package-templates', async (request) => {
    requireAdmin(request);
    return { templates: repo.listTemplates(db) };
  });

  app.post('/api/v1/admin/package-templates', async (request, reply) => {
    requireAdmin(request);
    const body = request.body ?? {};
    const name = requireString(body.name, 'name');
    const packaging = validatePackaging(body.packaging);
    if (repo.templateNameExists(db, name)) {
      throw fail(409, 'TEMPLATE_NAME_CONFLICT', `套餐模板 "${name}" 已存在`);
    }
    const items = validateTemplateItems(db, body.items);
    const template = repo.createTemplate(db, {
      name,
      packaging,
      active: body.active !== false,
      items,
    });
    reply.code(201);
    return { template };
  });

  app.put('/api/v1/admin/package-templates/:id', async (request) => {
    requireAdmin(request);
    const id = Number(request.params.id);
    if (!repo.getTemplate(db, id)) {
      throw fail(404, 'TEMPLATE_NOT_FOUND', `套餐模板 ${request.params.id} 不存在`);
    }
    const body = request.body ?? {};
    const patch = {};
    if (body.name !== undefined) {
      patch.name = requireString(body.name, 'name');
      if (repo.templateNameExists(db, patch.name, id)) {
        throw fail(409, 'TEMPLATE_NAME_CONFLICT', `套餐模板 "${patch.name}" 已存在`);
      }
    }
    if (body.packaging !== undefined) patch.packaging = validatePackaging(body.packaging);
    if (body.items !== undefined) patch.items = validateTemplateItems(db, body.items);
    return { template: repo.updateTemplate(db, id, patch) };
  });

  app.post('/api/v1/admin/package-templates/:id/toggle', async (request) => {
    requireAdmin(request);
    const id = Number(request.params.id);
    const current = repo.getTemplate(db, id);
    if (!current) throw fail(404, 'TEMPLATE_NOT_FOUND', `套餐模板 ${request.params.id} 不存在`);
    return { template: repo.setTemplateActive(db, id, !current.active) };
  });

  app.get('/api/v1/admin/batches', async (request) => {
    requireAdmin(request);
    return { batches: repo.listBatches(db) };
  });

  app.post('/api/v1/admin/batches', async (request, reply) => {
    requireAdmin(request);
    const body = request.body ?? {};
    const name = requireString(body.name, 'name');
    const cutoff = new Date(requireString(body.cutoffTime, 'cutoffTime'));
    if (Number.isNaN(cutoff.getTime()) || cutoff.getTime() <= Date.now()) {
      throw fail(422, 'CUTOFF_TIME_INVALID', '截单时间必须晚于当前时间');
    }
    if (repo.batchNameExists(db, name)) {
      throw fail(409, 'BATCH_NAME_CONFLICT', `批次 "${name}" 已存在`);
    }
    if (repo.batchDateExists(db, cutoff.toISOString())) {
      throw fail(409, 'BATCH_DATE_CONFLICT', '该配送日期已有批次，请编辑已有批次');
    }
    const batch = repo.createBatch(db, { name, cutoffTime: cutoff.toISOString() });
    reply.code(201);
    return { batch };
  });

  app.post('/api/v1/admin/batches/:id/close', async (request) => {
    requireAdmin(request);
    const id = Number(request.params.id);
    if (!repo.getBatch(db, id)) {
      throw fail(404, 'BATCH_NOT_FOUND', `批次 ${request.params.id} 不存在`);
    }
    return { batch: repo.closeBatch(db, id) };
  });

  app.put('/api/v1/admin/batches/:id', async (request) => {
    requireAdmin(request);
    const id = Number(request.params.id);
    const current = repo.getBatch(db, id);
    if (!current) throw fail(404, 'BATCH_NOT_FOUND', '批次不存在');
    if (current.status !== 'open') throw fail(409, 'BATCH_CLOSED', '已截单批次不能修改');
    const body = request.body ?? {};
    const patch = {};
    if (body.name !== undefined) {
      patch.name = requireString(body.name, 'name');
      if (patch.name !== current.name && repo.batchNameExists(db, patch.name)) {
        throw fail(409, 'BATCH_NAME_CONFLICT', '批次名称已存在');
      }
    }
    if (body.cutoffTime !== undefined) {
      const cutoff = new Date(requireString(body.cutoffTime, 'cutoffTime'));
      if (Number.isNaN(cutoff.getTime()) || cutoff.getTime() <= Date.now()) {
        throw fail(422, 'CUTOFF_TIME_INVALID', '截单时间必须晚于当前时间');
      }
      patch.cutoffTime = cutoff.toISOString();
      if (repo.batchDateExists(db, patch.cutoffTime, id)) {
        throw fail(409, 'BATCH_DATE_CONFLICT', '该配送日期已有批次，请编辑已有批次');
      }
    }
    return { batch: repo.updateBatch(db, id, patch) };
  });

  app.get('/api/v1/admin/settings', async (request) => {
    requireAdmin(request);
    return { settings: repo.listSettings(db) };
  });

  app.put('/api/v1/admin/settings', async (request) => {
    requireAdmin(request);
    const body = request.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
      throw fail(400, 'VALIDATION_ERROR', '请求体必须是非空的 key-value 对象');
    }
    for (const [key, value] of Object.entries(body)) {
      if (key === 'share.site_url') {
        body[key] = validateShareBaseUrl(value);
        continue;
      }
      if (key.startsWith('batch.') || key === 'templates.order') {
        throw fail(422, 'SETTINGS_KEY_RESERVED', '此配置由批次和排序接口管理');
      }
      // 满减优惠码活动的配置有专门的接口（活动码是字符串、还要做生效/用满判定），
      // 在这里单独改某个 key 会造出半套配置（比如只改了张数、没改码），所以直接锁掉。
      if (key.startsWith('coupon.')) {
        throw fail(422, 'SETTINGS_KEY_RESERVED', '此配置由「满减优惠码」接口管理');
      }
      if (!/^[a-z][a-z0-9_.]*$/i.test(key)) {
        throw fail(422, 'SETTINGS_KEY_INVALID', `设置项 key "${key}" 格式非法`);
      }
      if (!Number.isInteger(value)) {
        throw fail(422, 'SETTINGS_VALUE_INVALID', `设置项 ${key} 必须是整数（单位：分）`);
      }
    }
    db.tx(() => {
      for (const [key, value] of Object.entries(body)) repo.setSetting(db, key, value);
    })();
    return { settings: repo.listSettings(db) };
  });

  // 公告写入：content 可空（空即下线公告），activeFrom 必填，activeUntil 可空（长期有效）。
  app.put('/api/v1/admin/notice', async (request) => {
    requireAdmin(request);
    const body = request.body ?? {};
    if (body.content !== undefined && typeof body.content !== 'string') {
      throw fail(422, 'NOTICE_CONTENT_INVALID', 'content 必须是字符串');
    }
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const activeFrom = requireDateString(body.activeFrom, 'activeFrom');
    const activeUntil = (body.activeUntil === undefined || body.activeUntil === null || body.activeUntil === '')
      ? null
      : requireDateString(body.activeUntil, 'activeUntil');
    return { notice: repo.setNotice(db, { content, activeFrom, activeUntil }) };
  });

  /* ---------------- 满减优惠码活动（后台可配置，取代旧的关键词券） ----------------

     落点：settings 表五个 key（coupon.activity.*，见 configRepo.COUPON_KEYS）。
     为什么单开接口而不走 PUT /admin/settings：活动码是字符串（那个接口只收整数分），
     而且在那里能单独改张数绕过活动码校验，容易配出半套活动 —— 那边已显式锁掉 coupon.* 。
     「已用 N 张 / 剩余 M 张」由 GET /api/v1/admin/coupon/orders（routes/orders.js）一起返回。 */

  app.get('/api/v1/admin/coupon', async (request) => {
    requireAdmin(request);
    return { coupon: repo.getCouponActivityState(db) };
  });

  /** 覆盖写入活动配置（PUT 是整套配置，不做部分更新，避免半套活动）。 */
  app.put('/api/v1/admin/coupon', async (request) => {
    requireAdmin(request);
    return { coupon: repo.setCouponActivity(db, validateCouponActivityPayload(request.body ?? {})) };
  });

  /**
   * 「点击生效」/「停用」：只切开关，不动已配好的门槛、面额、张数。
   * 未配置（没有活动码 / 张数为 0）时拒绝 —— 否则管理员会以为活动上线了、实际用户用不了。
   */
  app.post('/api/v1/admin/coupon/toggle', async (request) => {
    requireAdmin(request);
    const current = repo.getCouponActivityState(db);
    if (!current.configured) {
      throw fail(422, 'COUPON_NOT_CONFIGURED', '请先保存活动配置（活动码、门槛、面额、总张数），再点生效');
    }
    const body = request.body ?? {};
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      throw fail(422, 'VALIDATION_ERROR', 'enabled 必须是布尔值');
    }
    return { coupon: repo.setCouponActivityEnabled(db, body.enabled ?? !current.enabled) };
  });
}
