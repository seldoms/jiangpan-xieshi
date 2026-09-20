/**
 * 功能验证用演示数据：走真实 HTTP API 灌满全流程数据。
 *
 *   node scripts/seed-demo-data.mjs                    # 默认打本机 7649
 *   API_BASE=http://127.0.0.1:7649 ADMIN_CODE=xxx node scripts/seed-demo-data.mjs
 *
 * 用途：让批次汇总、订单卡片、金额、履约状态都有真实数据，便于核对界面规格
 * （字号、控件高度、金额与图表区）。幂等：重复执行不会重复建单。
 * 注意：这是功能验证数据，正式价格由管理端「发售配置 → 规格单价 → 改价」录入。
 */

const API = process.env.API_BASE ?? 'http://127.0.0.1:7649';
const ADMIN_CODE = process.env.ADMIN_CODE;
if (!ADMIN_CODE) throw new Error('请通过 ADMIN_CODE 显式设置演示环境管理员下单码');
const CUSTOMER_CODE = process.env.CUSTOMER_CODE ?? '测试客户t1001';

async function api(path, { method = 'GET', code, body, expect } = {}) {
  const res = await fetch(API + path, {
    method,
    // 下单码可能是中文，HTTP header 只接受 latin-1，必须按前端口径 URL 编码。
    headers: {
      'Content-Type': 'application/json',
      ...(code ? { 'X-Order-Code': encodeURIComponent(code) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  if (!res.ok && res.status !== expect) {
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return { status: res.status, json };
}

const log = (msg) => console.log(msg);

// ---------- 1. 批次 ----------
async function ensureBatch() {
  const { json } = await api('/api/v1/admin/batches', { code: ADMIN_CODE });
  const open = json.batches.find((b) => b.status === 'open');
  if (open) { log(`批次已存在：#${open.id} ${open.name}`); return open; }
  const cutoff = new Date();
  cutoff.setHours(23, 59, 0, 0);
  const { json: created } = await api('/api/v1/admin/batches', {
    method: 'POST', code: ADMIN_CODE,
    body: { name: `${cutoff.toISOString().slice(0, 10)} 鲜蟹`, cutoffTime: cutoff.toISOString() },
  });
  log(`已创建批次：#${created.batch.id} ${created.batch.name}，截单 ${created.batch.cutoffTime}`);
  return created.batch;
}

// ---------- 2. 规格（全局，跨批次长期有效）----------
const SPEC_DEFS = [
  { gender: 'male', weightLabel: '4两', priceCents: 7800, sort: 1 },
  { gender: 'male', weightLabel: '3.5两', priceCents: 5800, sort: 2 },
  { gender: 'female', weightLabel: '3.5两', priceCents: 8800, sort: 3 },
  { gender: 'female', weightLabel: '3两', priceCents: 6800, sort: 4 },
];

async function ensureSpecs() {
  const { json } = await api('/api/v1/admin/specs', { code: ADMIN_CODE });
  const existing = new Map(json.specs.map((s) => [`${s.gender}|${s.weightLabel}`, s]));
  const out = {};
  for (const def of SPEC_DEFS) {
    const key = `${def.gender}|${def.weightLabel}`;
    if (existing.has(key)) { out[key] = existing.get(key); continue; }
    const { json: created } = await api('/api/v1/admin/specs', {
      method: 'POST', code: ADMIN_CODE,
      body: { ...def, active: true, batchId: null },
    });
    out[key] = created.spec;
    log(`已创建规格：${def.gender === 'male' ? '公' : '母'}${def.weightLabel} ¥${def.priceCents / 100}/只`);
  }
  if (Object.keys(out).length === SPEC_DEFS.length) log(`规格就绪 ${Object.keys(out).length} 项`);
  return out;
}

// ---------- 3. 套餐模板 ----------
async function ensureTemplates(specs) {
  const { json } = await api('/api/v1/admin/package-templates', { code: ADMIN_CODE });
  const byName = new Map(json.templates.map((t) => [t.name, t]));
  const defs = [
    { name: '5公5母经典礼盒', packaging: 'gift', items: [[specs['male|4两'].id, 5], [specs['female|3.5两'].id, 5]] },
    { name: '全母精选礼盒', packaging: 'gift', items: [[specs['female|3.5两'].id, 5], [specs['female|3两'].id, 5]] },
  ];
  for (const d of defs) {
    if (byName.has(d.name)) { log(`套餐已存在：${d.name}`); continue; }
    await api('/api/v1/admin/package-templates', {
      method: 'POST', code: ADMIN_CODE,
      body: { name: d.name, packaging: d.packaging, items: d.items.map(([specId, quantity]) => ({ specId, quantity })) },
    });
    log(`已创建套餐：${d.name}`);
  }
}

// ---------- 4. 包装价格 ----------
async function ensurePackagingPrices() {
  await api('/api/v1/admin/settings', {
    method: 'PUT', code: ADMIN_CODE,
    body: { 'packaging.plain': 0, 'packaging.gift': 1000 },
  });
  log('包装价格：普通 0 元 / 礼盒 10 元每盒');
}

// ---------- 5. 订单 ----------
const ORDERS = [
  { key: 'demo-1', note: '单地址·自由搭配·普通包装', shipments: [
    { recipient: '林小满', phone: '13900001234', address: '江苏省扬州市江都区水乡路18号3栋2单元501', packaging: 'plain',
      items: [{ spec: 'male|4两', qty: 5 }, { spec: 'female|3.5两', qty: 5 }] }] },
  { key: 'demo-2', note: '一单三地址·不同规格', shipments: [
    { recipient: '王小明', phone: '13812345678', address: '江苏省南京市鼓楼区中山北路128号金盛大厦18层', packaging: 'plain',
      items: [{ spec: 'male|4两', qty: 10 }] },
    { recipient: '陈静', phone: '13698765432', address: '上海市浦东新区张杨路500号世纪汇广场B座2201', packaging: 'gift',
      items: [{ spec: 'female|3.5两', qty: 10 }] },
    { recipient: '赵大力', phone: '13512340001', address: '浙江省杭州市西湖区文三路256号数娱大厦9层', packaging: 'plain', copies: 2,
      items: [{ spec: 'male|3.5两', qty: 5 }, { spec: 'female|3两', qty: 5 }] }] },
  { key: 'demo-3', note: '礼盒·全母', shipments: [
    { recipient: '周雅琴', phone: '13300001234', address: '江苏省扬州市邗江区文昌西路450号万科城12幢', packaging: 'gift',
      items: [{ spec: 'female|3.5两', qty: 10 }] }] },
  { key: 'demo-4', note: '混合规格·20只', shipments: [
    { recipient: '孙志强', phone: '13911112222', address: '北京市朝阳区建国路88号SOHO现代城C座1802', packaging: 'plain',
      items: [{ spec: 'male|4两', qty: 10 }, { spec: 'female|3.5两', qty: 10 }] }] },
  { key: 'demo-5', note: '不足10只（已确认）', confirmBelowTen: true, shipments: [
    { recipient: '吴小凤', phone: '13700003333', address: '江苏省扬州市江都区龙川北路36号', packaging: 'plain',
      items: [{ spec: 'female|3两', qty: 6 }] }] },
  { key: 'demo-6', note: '单地址·待发货', shipments: [
    { recipient: '郑海涛', phone: '13622224444', address: '广东省深圳市南山区科技园南路15号', packaging: 'gift',
      items: [{ spec: 'male|4两', qty: 6 }, { spec: 'female|3两', qty: 4 }] }] },
  { key: 'demo-7', note: '单地址·待发货', shipments: [
    { recipient: '黄丽娜', phone: '13933335555', address: '江苏省无锡市滨湖区太湖大道1200号', packaging: 'plain',
      items: [{ spec: 'female|3.5两', qty: 10 }] }] },
  { key: 'demo-8', note: '单地址·待发货', shipments: [
    { recipient: '许建国', phone: '13844446666', address: '江苏省泰州市海陵区凤凰东路9号', packaging: 'plain',
      items: [{ spec: 'male|3.5两', qty: 10 }] }] },
];

async function createOrders(specs) {
  const created = [];
  for (const def of ORDERS) {
    const shipments = def.shipments.map((s) => ({
      recipient: s.recipient,
      phone: s.phone,
      address: s.address,
      packaging: s.packaging,
      copies: s.copies ?? 1,
      items: s.items.map((it) => ({ specId: specs[it.spec].id, qty: it.qty })),
    }));
    const { status, json } = await api('/api/v1/orders', {
      method: 'POST', code: CUSTOMER_CODE,
      body: { shipments, idempotencyKey: def.key, confirmBelowTen: def.confirmBelowTen === true },
      expect: 200,
    });
    created.push({ ...def, order: json.order, shipments: json.shipments, reused: status === 200 });
    log(`${status === 200 ? '已存在' : '已下单'} ${json.order.orderNo}｜${def.note}｜${shipments.length} 个地址｜${(json.order.amount.totalCents / 100).toFixed(2)} 元`);
  }
  return created;
}

// ---------- 6. 履约推进：制造三种状态 ----------
async function advanceFulfillment(orders) {
  const all = [];
  for (const o of orders) for (const s of o.shipments) all.push({ order: o, shipment: s });
  // 前 150 单保持"捕捞中"；取 3 张推进到已打包；取 2 张登记运费发货
  const packed = all.slice(3, 6);
  const shipped = all.slice(6, 8);
  for (const { shipment } of packed) {
    if (shipment.status !== 'fishing') continue;
    await api(`/api/v1/admin/shipments/${shipment.id}/transition`, { method: 'POST', code: ADMIN_CODE, body: { to: 'packed' } });
    log(`已打包：发货单 #${shipment.id} ${shipment.recipient}`);
  }
  const freightPlan = [1500, 2200];
  let i = 0;
  for (const { shipment } of shipped) {
    if (shipment.status === 'fishing') {
      await api(`/api/v1/admin/shipments/${shipment.id}/transition`, { method: 'POST', code: ADMIN_CODE, body: { to: 'packed' } });
    }
    if (shipment.status !== 'shipped') {
      await api(`/api/v1/admin/shipments/${shipment.id}/freight`, {
        method: 'POST', code: ADMIN_CODE, body: { freightCents: freightPlan[i % freightPlan.length] },
      });
      log(`已发货：发货单 #${shipment.id} ${shipment.recipient} 运费 ${(freightPlan[i % freightPlan.length] / 100).toFixed(2)} 元`);
    }
    i += 1;
  }
}

async function main() {
  log(`目标后端 ${API}`);
  const batch = await ensureBatch();
  const specs = await ensureSpecs();
  await ensureTemplates(specs);
  await ensurePackagingPrices();

  // 下单用户首次登录即自动建号
  await api('/api/v1/auth/login', { method: 'POST', body: { orderCode: CUSTOMER_CODE } });
  const { json: config } = await api('/api/v1/config/current');
  log(`在售配置：批次 ${config.batch?.name ?? '无'}｜规格 ${config.specs.length} 项｜套餐 ${config.templates.length} 项｜礼盒 ${config.packagingPrices.gift / 100} 元`);

  const orders = await createOrders(specs);
  await advanceFulfillment(orders);

  const { json: summary } = await api(`/api/v1/admin/batch/summary?batchId=${batch.id}`, { code: ADMIN_CODE });
  log('');
  log('=== 当前批次汇总 ===');
  log(`订单 ${summary.orderCount} 笔｜发货单 ${summary.shipmentCount} 张｜总只数 ${summary.totalsBySpec.reduce((n, r) => n + r.quantity, 0)} 只`);
  log(`状态：捕捞中 ${summary.statusCounts.fishing} / 已打包 ${summary.statusCounts.packed} / 已发货 ${summary.statusCounts.shipped}`);
  log(`预计收入 ${(summary.revenueCents / 100).toFixed(2)} 元（蟹款 ${(summary.revenue.crabCents / 100).toFixed(2)} + 包装 ${(summary.revenue.packagingCents / 100).toFixed(2)} + 运费 ${(summary.revenue.freightCents / 100).toFixed(2)}，${summary.revenue.freightPendingCount} 张运费待录）`);
}

main().catch((err) => { console.error('失败：', err.message); process.exit(1); });
