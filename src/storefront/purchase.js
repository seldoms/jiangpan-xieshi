// 纯展示计算：份数、盒数、预览金额。下单金额一律以后端结算为准，这里只用于选购页预览。
// 数据全部来自 GET /api/v1/config/current，规格、套餐和价格不在前端写死。

export const BOX_CAPACITY = 10

// 普通包装今年不提供（只出礼盒）：地址弹窗里的「普通包装」置灰不可选。
// 明年恢复普通包装时把这里改成 true 即可，其它代码不用动。
export const PLAIN_PACKAGING_ENABLED = false

// 公蟹 2026-10-01 开售。后端 GET /api/v1/config/current 的 specs[] 会带 orderable
// （该接口已实现但尚未发布），所以两种口径都兼容：后端字段优先，没有就按日期自己算。
export const MALE_SPEC_OPEN_AT = new Date('2026-10-01T00:00:00+08:00')

export function isSpecOrderable(spec, now = Date.now()) {
  if (!spec) return false
  // 缺货优先：标了缺货就不可下单（公母、日期都不看）。
  // 后端 config/current 也会给出 orderable=false，这里再判一次是为了
  // 后端未发布/字段缺失时前端同样能置灰，两边不会各说各话。
  if (spec.soldOut === true) return false
  // 只在后端明确给了布尔值时才信它（字段缺失／为 null 都走本地日期判断）。
  if (typeof spec.orderable === 'boolean') return spec.orderable
  return spec.gender === 'male' ? now >= MALE_SPEC_OPEN_AT.getTime() : true
}

// 规格不可下单的原因文案（有货且有开售日期限制 vs 直接缺货）。
export function specClosedReason(spec, now = Date.now()) {
  if (!spec) return '已下架'
  if (isSpecOrderable(spec, now)) return ''
  if (spec.soldOut === true) return '缺货'
  return spec.gender === 'male' && now < MALE_SPEC_OPEN_AT.getTime() ? '10 月 1 日后开售' : '暂不可选'
}

// 从最新规格表检查旧选择和套装明细，避免用下单快照里的旧可售状态。
export function itemsAvailabilityError(specs, items) {
  for (const item of items ?? []) {
    if (Number(item.qty ?? item.quantity) <= 0) continue
    const spec = specs?.find((entry) => entry.id === Number(item.specId))
    if (!isSpecOrderable(spec)) {
      return `${spec ? specLabel(spec) : '原规格'}${specClosedReason(spec)}，请调整搭配后再提交。`
    }
  }
  return ''
}

export function selectionAvailabilityError(config, selection) {
  if (selection?.mode === 'template') {
    const template = findTemplate(config, selection.templateId)
    if (!template) return '原预设套装已下架，请重新选择。'
    return itemsAvailabilityError(config?.specs, template.items)
  }
  return itemsAvailabilityError(config?.specs, Object.entries(selection?.items ?? {})
    .map(([specId, qty]) => ({ specId: Number(specId), qty })))
}

export function getCutoffStatus(now = new Date(), cutoffHour = 17, timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
  const minutes = values.hour * 60 + values.minute + values.second / 60
  return {
    passed: minutes >= cutoffHour * 60,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
    timeZone,
  }
}

// 批次截单时间（UTC ISO）按中国时区格式化为 HH:mm 用于展示。
export function formatCutoffTime(isoUtc, timeZone = 'Asia/Shanghai') {
  const date = new Date(isoUtc)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('hour')}:${get('minute')}`
}

// 发货日跟随批次；晚间新单属于次日，不能继续提示“当天发走”。
export function formatBatchSchedule(isoUtc, now = new Date()) {
  const date = new Date(isoUtc)
  if (!isoUtc || Number.isNaN(date.getTime())) return ''
  const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  const day = formatter.format(date)
  const label = day === formatter.format(now) ? '今日' : day === formatter.format(new Date(now.getTime() + 86400000)) ? '明日' : `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`
  return `${label}发货 · ${formatCutoffTime(isoUtc)} 截单`
}

export function specLabel(spec) {
  return `${spec.weightLabel}${spec.gender === 'male' ? '公蟹' : '母蟹'}`
}

export function packagingLabel(packaging) {
  return packaging === 'gift' ? '礼盒' : '普通包装'
}

export function findTemplate(config, templateId) {
  return config?.templates?.find((template) => template.id === templateId) ?? null
}

// 默认选购：自定义模式，第一种公蟹和第一种母蟹各 5 只。
// 已停售（公蟹 10-01 前）的规格不预选，否则一进选蟹页就带着几只好不了单的蟹。
export function defaultSelection(config) {
  const items = {}
  const male = config?.specs?.find((spec) => spec.gender === 'male' && isSpecOrderable(spec))
  const female = config?.specs?.find((spec) => spec.gender === 'female' && isSpecOrderable(spec))
  if (male) items[male.id] = 5
  if (female) items[female.id] = 5
  return { mode: 'custom', templateId: null, items }
}

// 当前选购内容展开为「每份明细」：套餐模式取模板明细，自定义模式取用户选配。
export function selectionItems(config, selection) {
  if (!config || !selection) return []
  if (selection.mode === 'template') {
    const template = findTemplate(config, selection.templateId)
    return (template?.items ?? []).map((item) => ({
      specId: item.specId,
      qty: item.quantity,
      gender: item.gender,
      weightLabel: item.weightLabel,
      priceCents: item.priceCents,
    }))
  }
  return (config.specs ?? [])
    .filter((spec) => (selection.items?.[spec.id] ?? 0) > 0)
    .map((spec) => ({
      specId: spec.id,
      qty: selection.items[spec.id],
      gender: spec.gender,
      weightLabel: spec.weightLabel,
      priceCents: spec.priceCents,
    }))
}

// 套餐模式的包装由模板决定；自定义模式返回 null，由每个地址各自选择。
export function selectionPackaging(config, selection) {
  if (selection?.mode !== 'template') return null
  return findTemplate(config, selection.templateId)?.packaging ?? 'plain'
}

// 盒数规则：每盒固定 10 只，自定义模式不足 10 只也算 1 盒。
export function boxesFor(count) {
  if (!Number.isInteger(count) || count <= 0) return 0
  return Math.max(1, Math.ceil(count / BOX_CAPACITY))
}

// 配置条目的展示名：套餐用模板名，自定义搭配用只数概括。
export function configLabel(config, entry) {
  if (!entry) return '未选配置'
  if (entry.label) return entry.label
  if (entry.mode === 'template') return findTemplate(config, entry.templateId)?.name ?? '预设套装'
  const count = selectionItems(config, entry).reduce((sum, item) => sum + item.qty, 0)
  return count > 0 ? `自定义搭配 ${count} 只` : '自定义搭配'
}

// 草稿里的配置清单；旧草稿（只有单个 selection）降级成一条，保证升级后仍打得开。
export function draftEntries(config, selection, entries, activeConfigId = null) {
  const saved = Array.isArray(entries) ? entries : []
  if (!selection) return saved
  // 正在编辑清单里已存在的那条（从购物车「继续下单」进来时就是这个情形）：
  // 用它替换那一条，而不是「原来的 + 正在编辑的」两条相加 —— 否则改数量后清单纹丝不动或翻倍。
  const index = saved.findIndex((entry) => entry.id === activeConfigId)
  if (index >= 0) {
    return saved.map((entry, i) => (i === index ? { ...entry, ...selection, id: entry.id } : entry))
  }
  // 清单里已经有完全一样的一份搭配：不再叠加（保存时也会提示重复）
  if (config && findDuplicateConfig(config, saved, selection)) return saved
  return [...saved, { id: 'legacy', ...selection }]
}

// 一条地址 = 一套。套内容由它挂的配置决定，不再有「份数」概念。
// 包装：地址自己指定了就用地址的，否则跟随购物车的整车包装。
// （同一收货人想混装礼盒/普通，就填两条地址，提交时自然拆成两张发货单。）
export function shipmentPreview(config, entry, address, cartPackaging) {
  const items = selectionItems(config, entry)
  const perCopyCount = items.reduce((sum, item) => sum + item.qty, 0)
  const perCopyCents = items.reduce((sum, item) => sum + item.qty * item.priceCents, 0)
  const override = address?.packaging === 'gift' || address?.packaging === 'plain' ? address.packaging : null
  const packaging = override ?? (cartPackaging === 'gift' ? 'gift' : 'plain')
  const boxes = boxesFor(perCopyCount)
  const packagingCents = boxes * (config?.packagingPrices?.[packaging] ?? 0)
  return {
    items,
    configId: entry?.id ?? null,
    // 预设套装：清单里按套装整条显示（不拆成规格明细）；自定义套装才逐规格列。
    mode: entry?.mode ?? 'custom',
    templateName: entry?.mode === 'template' ? (findTemplate(config, entry.templateId)?.name ?? null) : null,
    perCopyCount,
    totalCount: perCopyCount,
    boxes,
    packaging,
    packagingOverridden: Boolean(override),
    crabCents: perCopyCents,
    packagingCents,
    totalCents: perCopyCents + packagingCents,
  }
}

// 整单预览：逐地址金额 + 汇总。每条地址按自己挂的配置算，一条地址就是一套。
export function calculatePurchase(config, entries, addresses, cartPackaging) {
  const list = entries ?? []
  const shipments = (addresses ?? []).map((address) => {
    const entry = list.find((item) => item.id === address.configId) ?? list[0] ?? null
    return shipmentPreview(config, entry, address, cartPackaging)
  })
  const countBy = (gender) => shipments.reduce(
    (sum, shipment) => sum + shipment.items
      .filter((item) => item.gender === gender)
      .reduce((inner, item) => inner + item.qty, 0),
    0,
  )
  const sum = (key) => shipments.reduce((total, shipment) => total + shipment[key], 0)
  return {
    shipments,
    maleCount: countBy('male'),
    femaleCount: countBy('female'),
    totalCount: sum('totalCount'),
    packageUnits: shipments.length,
    boxCount: sum('boxes'),
    crabCents: sum('crabCents'),
    packagingCents: sum('packagingCents'),
    totalCents: sum('totalCents'),
    belowTenCount: shipments.filter((shipment) => shipment.totalCount > 0 && shipment.totalCount < BOX_CAPACITY).length,
  }
}

// 生成提交给 POST /api/v1/orders 的 shipments：每条地址一套，带自己挂的配置 + 包装。
export function buildShipmentsPayload(config, entries, addresses, cartPackaging) {
  const list = entries ?? []
  const fallback = cartPackaging === 'gift' ? 'gift' : 'plain'
  return (addresses ?? []).map((address) => {
    const entry = list.find((item) => item.id === address.configId) ?? list[0] ?? null
    const packaging = address.packaging === 'gift' || address.packaging === 'plain' ? address.packaging : fallback
    const base = {
      recipient: (address.name ?? '').trim(),
      phone: (address.phone ?? '').trim(),
      address: (address.address ?? '').trim(),
      packaging,
    }
    if (entry?.mode === 'template') {
      return { ...base, templateId: entry.templateId, copies: 1 }
    }
    return { ...base, items: selectionItems(config, entry).map((item) => ({ specId: item.specId, qty: item.qty })) }
  })
}

// 两条配置是否等价：套餐比模板，自定义搭配比「规格 → 数量」完整映射。
export function sameConfig(config, a, b) {
  if (!a || !b) return false
  if ((a.mode ?? 'custom') !== (b.mode ?? 'custom')) return false
  if (a.mode === 'template') return a.templateId === b.templateId
  const mapA = selectionItems(config, a).map((item) => `${item.specId}:${item.qty}`).sort().join('|')
  const mapB = selectionItems(config, b).map((item) => `${item.specId}:${item.qty}`).sort().join('|')
  return mapA.length > 0 && mapA === mapB
}

// 同一份搭配只允许在购物车里存在一条，避免用户误以为「加两次就等于两套」。
export function findDuplicateConfig(config, entries, candidate) {
  return (entries ?? []).find((entry) => sameConfig(config, entry, candidate)) ?? null
}

// ---------- 满减优惠码（后台可配置的限量活动，取代旧的关键词券）----------
// 一个活动码、所有用户共用；后台配门槛（满 X 元）/ 面额（减 Y 元）/ 总张数 N，
// 点「生效」后才能用，**用满 N 次自动结束**（剩余 = 总张数 - 已用张数，
// 已取消/已退款的订单也算用掉、不退回）。
//
// 活动状态由后端下发：GET /api/v1/config/current 的 coupon 字段
// （口径见 server/src/repositories/configRepo.js 的 getCouponActivityState）。
// 前端这份**只用于结算预览**；真正算钱、限次、是否生效一律以后端 createOrder 为准，
// 后端拒绝时返回 COUPON_* 错误码，照实展示即可。
// 券码必须来自**独立输入框**，绝不能从订单备注里读（备注是自由文本，会误触发）。

/** 还没配置 / 后端没下发时的空活动：任何码都用不了。 */
export const EMPTY_COUPON_ACTIVITY = Object.freeze({
  code: '',
  minCents: 0,
  discountCents: 0,
  total: 0,
  enabled: false,
  configured: false,
  used: 0,
  remaining: 0,
  active: false,
  ended: false,
})

/** 金额（分）→ 以元为单位的展示串，整数不带小数。 */
function yuanLabel(cents) {
  const yuan = (cents ?? 0) / 100
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)
}

/**
 * 结算预览：活动状态 + 蟹款 + 输入的券码 → { code, discountCents, error }。
 * error 非空 = 现在用不了（活动没配/没生效/码不对/已用完/未达门槛），此时不减免。
 * 判定顺序与文案和后端 money.resolveCouponActivity 对齐；门槛按**蟹款**判定
 * （不含包装费、运费）—— 运费是发货前才录的，含它在提交那一刻没法判。
 */
export function couponPreview(activity, crabCents, code) {
  const text = String(code ?? '').trim()
  if (!text) return { code: null, discountCents: 0, error: '' }
  const config = activity ?? EMPTY_COUPON_ACTIVITY
  if (!config.code || !(config.total > 0)) {
    return { code: null, discountCents: 0, error: '当前没有可用的满减优惠活动' }
  }
  if (!config.enabled) {
    return { code: null, discountCents: 0, error: '满减优惠活动尚未生效，请等活动开启后再使用' }
  }
  if (text !== config.code) {
    return { code: null, discountCents: 0, error: `优惠码「${text}」不正确，请核对后重新输入` }
  }
  if ((config.remaining ?? 0) <= 0) {
    return {
      code: null,
      discountCents: 0,
      error: `优惠码「${config.code}」已用完（共 ${config.total} 张），活动已结束`,
    }
  }
  if ((crabCents ?? 0) < config.minCents) {
    return {
      code: null,
      discountCents: 0,
      error: `蟹款满 ${yuanLabel(config.minCents)} 元才能使用「${config.code}」（当前蟹款 ${yuanLabel(crabCents)} 元，不含包装费和运费）`,
    }
  }
  // 减免不超过蟹款：金额永远不会被减成负数。
  return { code: config.code, discountCents: Math.min(config.discountCents, crabCents ?? 0), error: '' }
}

/** 券栏的一行说明：让用户知道门槛、面额和还剩几张。 */
export function couponActivityHint(activity) {
  if (!activity || !activity.code || !(activity.total > 0)) return ''
  const rule = `满 ${yuanLabel(activity.minCents)} 元减 ${yuanLabel(activity.discountCents)} 元`
  if (!activity.enabled) return `${rule}（活动尚未生效）`
  if ((activity.remaining ?? 0) <= 0) return `${rule}（已用完，活动结束）`
  return `${rule} · 剩余 ${activity.remaining} 张`
}
