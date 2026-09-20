#!/usr/bin/env node
/**
 * 造演示订单：11 个用户 + 48 个订单，配置随机（总量恒为 10 的倍数），状态分布三档。
 *
 * 用途：录演示视频时铺满「我的套装 / 我的订单 / 发货卡片」等页面。
 *
 * 幂等：幂等键固定为 demo-N，重复执行不会重复下单（接口会返回已有订单）。
 * 可复现：随机数用固定种子（SEED 环境变量），同样的种子出同样的配置。
 *
 * 用法：
 *   API_BASE=http://127.0.0.1:7649 node scripts/seed-demo-orders.mjs
 *   DRY=1 API_BASE=... node scripts/seed-demo-orders.mjs     # 只打印计划，不发请求
 */

const BASE = (process.env.API_BASE || 'http://127.0.0.1:7649').replace(/\/$/, '') + '/api/v1';
const ADMIN_CODE = process.env.ADMIN_CODE;
if (!ADMIN_CODE) throw new Error('请通过 ADMIN_CODE 显式设置演示环境管理员下单码');
const DRY = process.env.DRY === '1';

const USERS = ['张建军', '李秀华', '王海燕', '刘志强', '陈晓明', '杨丽萍', '赵文静', '周国栋', '吴美琳', '郑志刚', '孙雅琴'];
const TOTAL_ORDERS = 48;
const TOTAL_CHOICES = [10, 20, 30, 40];
// 拟真到「路 + 小区 + 楼栋室」，跟用户从京东/顺丰复制过来的一模一样
const STREETS = [
  '江苏省扬州市江都区龙川北路128号金奥文昌公馆3栋1502室',
  '江苏省扬州市邗江区文昌西路456号京华城御景苑B区7栋802室',
  '江苏省扬州市广陵区汶河北路88号万科翡翠公园12栋2301室',
  '江苏省扬州市江都区仙女镇龙川南路66号明珠御景苑5栋1103室',
  '江苏省扬州市邗江区兴城西路200号橡树湾花园9栋1602室',
  '江苏省扬州市江都区邵伯镇运河东路33号运河人家2栋905室',
  '江苏省扬州市广陵区文昌中路320号绿地中央广场6栋1806室',
  '江苏省扬州市江都区龙城路45号龙城雅苑4栋1201室',
  '江苏省扬州市邗江区文汇西路288号锦富华庭8栋703室',
  '江苏省扬州市江都区大桥镇沿江路12号滨江花园1栋501室',
  '江苏省扬州市广陵区东关街102号古运河畔小区3栋402室',
  '江苏省扬州市江都区宜陵镇镇南路77号宜陵家园6栋1002室',
];
// 演示统一号码：176 开头 + 后 8 个 0（用户指定，避免误用真实号码）
const DEMO_PHONE = '17600000000';

let seed = Number(process.env.SEED || 20260920);
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

async function req(method, path, { body, code } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (code) headers['X-Order-Code'] = encodeURIComponent(code);
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, data, text };
}

/** 把总量拆成 1~3 个规格，各数量之和 === 总量（总量是 10 的倍数）
 *  先等分再随机搬移：避免出现「一个规格吃掉绝大部分」这种不像真人的配置。 */
function splitRandom(totalCount, specs) {
  const roll = rnd();
  const k = Math.min(specs.length, roll < 0.2 ? 1 : roll < 0.7 ? 2 : 3);
  const pool = [...specs];
  const chosen = [];
  for (let i = 0; i < k; i += 1) chosen.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  const base = Math.floor(totalCount / k);
  const qty = new Array(k).fill(base);
  for (let i = 0; i < totalCount - base * k; i += 1) qty[i] += 1;
  for (let round = 0; round < k; round += 1) {
    const a = int(0, k - 1);
    const b = int(0, k - 1);
    if (a === b) continue;
    const move = int(1, Math.max(1, Math.floor(qty[a] / 3)));
    if (qty[a] - move >= 1) { qty[a] -= move; qty[b] += move; }
  }
  return chosen.map((spec, i) => ({
    specId: spec.id,
    qty: qty[i],
    label: `${spec.gender === 'male' ? '公' : '母'}${spec.weightLabel}`,
  }));
}

(async () => {
  const cfg = await req('GET', '/config/current');
  if (cfg.status !== 200) throw new Error(`读取配置失败：${cfg.status} ${cfg.text}`);
  const specs = cfg.data.specs.filter((s) => s.active !== false);
  if (specs.length < 2) throw new Error('可售规格不足 2 个，先到后台配规格');
  console.log(`接口：${BASE}`);
  console.log(`可售规格：${specs.map((s) => `${s.id}:${s.gender === 'male' ? '公' : '母'}${s.weightLabel}`).join('  ')}`);

  // ① 建账号
  console.log(`\n① 建 ${USERS.length} 个账号${DRY ? '（dry-run 跳过）' : ''}`);
  for (const name of USERS) {
    if (DRY) { console.log(`   [dry] ${name}`); continue; }
    const r = await req('POST', '/auth/login', { body: { orderCode: name } });
    console.log(`   ${name}: ${r.status === 200 ? 'ok' : `${r.status} ${r.text.slice(0, 80)}`}`);
  }

  // ② 下单
  console.log(`\n② 下 ${TOTAL_ORDERS} 单（总量恒为 10 的倍数，礼盒）`);
  const plan = [];
  for (let i = 0; i < TOTAL_ORDERS; i += 1) {
    const owner = USERS[i % USERS.length];
    const totalCount = pick(TOTAL_CHOICES);
    const items = splitRandom(totalCount, specs);
    const sum = items.reduce((s, it) => s + it.qty, 0);
    if (sum !== totalCount || totalCount % 10 !== 0) throw new Error(`拆分自检失败：${sum} / ${totalCount}`);
    const phone = DEMO_PHONE;
    plan.push({
      index: i + 1, owner, totalCount, items,
      shipment: { recipient: owner, phone, address: pick(STREETS), packaging: 'gift', items: items.map(({ specId, qty }) => ({ specId, qty })) },
    });
  }
  plan.forEach((p) => console.log(`   ${String(p.index).padStart(2, '0')} ${p.owner}  ${p.totalCount} 只  ${p.items.map((it) => `${it.label}×${it.qty}`).join(' + ')}`));

  if (DRY) { console.log('\n[dry-run] 未发任何请求'); return; }

  const created = [];
  for (const p of plan) {
    const r = await req('POST', '/orders', {
      code: p.owner,
      body: {
        idempotencyKey: `demo-${p.index}`,
        confirmBelowTen: true,
        shipments: [p.shipment],
      },
    });
    if (r.status === 201 || r.status === 200) {
      created.push({ ...p, orderNo: r.data?.order?.orderNo, orderId: r.data?.order?.id, shipmentIds: (r.data?.shipments ?? []).map((s) => s.id) });
      console.log(`   单 ${String(p.index).padStart(2, '0')} ${p.owner} ${p.totalCount} 只 → ${r.data?.order?.orderNo}`);
    } else {
      console.log(`   单 ${String(p.index).padStart(2, '0')} ${p.owner} 失败：${r.status} ${r.text.slice(0, 120)}`);
    }
  }

  // ③ 状态分布：前 20 捕捞中，中 15 已打包，后 13 已发货（发货要录运费）
  const adminHeadersCode = ADMIN_CODE;
  const shippedFrom = created.length - 13;
  const packedFrom = shippedFrom - 15;
  console.log('\n③ 铺开状态');
  for (let i = 0; i < created.length; i += 1) {
    const c = created[i];
    const sid = c.shipmentIds[0];
    if (!sid) continue;
    if (i >= shippedFrom) {
      await req('POST', `/admin/shipments/${sid}/transition`, { code: adminHeadersCode, body: { to: 'packed' } });
      const freight = int(8, 20) * 100;
      const r = await req('POST', `/admin/shipments/${sid}/freight`, { code: adminHeadersCode, body: { freightCents: freight, weightGrams: c.totalCount * 200 } });
      console.log(`   ${c.orderNo} 已发货（运费 ${(freight / 100).toFixed(2)} 元）${r.status === 200 ? '' : ` ← ${r.status} ${r.text.slice(0, 80)}`}`);
    } else if (i >= packedFrom) {
      const r = await req('POST', `/admin/shipments/${sid}/transition`, { code: adminHeadersCode, body: { to: 'packed' } });
      console.log(`   ${c.orderNo} 已打包 ${r.status === 200 ? '' : `← ${r.status} ${r.text.slice(0, 80)}`}`);
    } else {
      console.log(`   ${c.orderNo} 捕捞中`);
    }
  }

  const byTotal = plan.reduce((m, p) => m.set(p.totalCount, (m.get(p.totalCount) ?? 0) + 1), new Map());
  console.log('\n汇总');
  console.log(`  账号：${USERS.length} 个`);
  console.log(`  订单：${created.length} 单（捕捞中 ${Math.max(0, packedFrom)} / 已打包 ${Math.min(15, created.length - packedFrom)} / 已发货 ${Math.min(13, created.length)}）`);
  console.log(`  只数分布：${[...byTotal].sort((a, b) => a[0] - b[0]).map(([t, n]) => `${t}只×${n}单`).join('  ')}`);
})().catch((err) => { console.error('失败：', err.message); process.exit(1); });
