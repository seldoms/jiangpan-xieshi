/**
 * 批量地址解析自测：node scripts/address-parser-selftest.mjs [--all]
 *
 * 覆盖姓名 / 电话 / 地址三个字段的随机顺序编排、分隔符变体、中文输入法
 * 全角与空格、数量段变体，以及手机号缺位/多位的异常处理。
 * 判定标准是“人读一遍会怎么理解”，不迁就实现细节，改解析器后跑同一套用例回归。
 *
 * 关于「数量」组：地址是核心功能，规格配置不是。解析器仍然识别行尾的
 * 「4公4母（2份）」并把这段文字从地址里剔除（避免污染地址），但导入时
 * **不再据此改写选蟹配置**——识别偏差会直接下错单。所以这一组验证的是
 * 「配置被正确剔除、地址保持干净」，而不是「配置被用于下单」。
 * 加 --all 打印逐条明细。
 */
import { parseBulkAddresses } from '../src/storefront/addressParser.js';

const A = '江苏省扬州市江都区水乡路18号3栋2单元501';

/** 单行用例：expect.name / phone 为 null 表示不应识别出该字段。 */
const CASES = [
  // ---- 正常顺序与分隔符 ----
  { g: '顺序', d: '姓名 电话 地址', line: `林小满 13900001234 ${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '顺序', d: '姓名,电话,地址', line: `林小满,13900001234,${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '顺序', d: '姓名、电话、地址', line: `林小满、13900001234、${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '顺序', d: '多空格分隔', line: `林小满   13900001234   ${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '顺序', d: '制表符分隔', line: `林小满\t13900001234\t${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '顺序', d: '电话在姓名前', line: `13900001234 林小满 ${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '顺序', d: '地址在姓名前', line: `${A} 林小满 13900001234`, name: '林小满', phone: '13900001234', addr: true },
  { g: '顺序', d: '姓名 地址 电话', line: `林小满 ${A} 13900001234`, name: '林小满', phone: '13900001234', addr: true },
  { g: '顺序', d: '电话 地址 姓名', line: `13900001234 ${A} 林小满`, name: '林小满', phone: '13900001234', addr: true },
  { g: '顺序', d: '地址 电话 姓名', line: `${A} 13900001234 林小满`, name: '林小满', phone: '13900001234', addr: true },
  { g: '顺序', d: '三字姓名', line: `王小明 13812345678 ${A}`, name: '王小明', phone: '13812345678', addr: true },
  { g: '顺序', d: '两字姓名', line: `张三 13812345678 ${A}`, name: '张三', phone: '13812345678', addr: true },
  { g: '顺序', d: '四字姓名', line: `欧阳修远 13812345678 ${A}`, name: '欧阳修远', phone: '13812345678', addr: true },

  // ---- 行首序号与空行 ----
  { g: '行格式', d: '行首序号 1.', line: `1. 林小满 13900001234 ${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '行格式', d: '行首序号 2、', line: `2、林小满 13900001234 ${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '行格式', d: '行首序号 (3)', line: `(3) 林小满 13900001234 ${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '行格式', d: '行首编号 A1', line: `A1 林小满 13900001234 ${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '行格式', d: '行首制表缩进', line: `\t林小满 13900001234 ${A}`, name: '林小满', phone: '13900001234', addr: true },

  // ---- 中文输入法 ----
  { g: '输入法', d: '全角数字手机号', line: `林小满 １３９００００１２３４ ${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '输入法', d: '全角空格分隔', line: `林小满　13900001234　${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '输入法', d: '电话含空格', line: `林小满 139 0000 1234 ${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '输入法', d: '姓名后带空格再电话', line: `林小满  13900001234 ${A}`, name: '林小满', phone: '13900001234', addr: true },
  { g: '输入法', d: '电话含短横', line: `林小满 139-0000-1234 ${A}`, name: '林小满', phone: '13900001234', addr: true },

  // ---- 数量段 ----
  { g: '数量', d: '现有格式 4公4母 2份', line: `林小满 13900001234 ${A} - 4公4母（2份）`, name: '林小满', phone: '13900001234', addr: true, male: 4, female: 4, copies: 2 },
  { g: '数量', d: '无横线 5公5母', line: `林小满 13900001234 ${A} 5公5母`, name: '林小满', phone: '13900001234', addr: true, male: 5, female: 5 },
  { g: '数量', d: '半角括号', line: `林小满 13900001234 ${A} - 3公7母(1份)`, name: '林小满', phone: '13900001234', addr: true, male: 3, female: 7, copies: 1 },
  { g: '数量', d: '全公', line: `林小满 13900001234 ${A} - 全公 10只`, name: '林小满', phone: '13900001234', addr: true },
  { g: '数量', d: '全母', line: `林小满 13900001234 ${A} - 全母`, name: '林小满', phone: '13900001234', addr: true },

  // ---- 异常：手机号 ----
  { g: '异常', d: '手机号 10 位（缺 1 位）', line: `林小满 1390000123 ${A}`, name: '林小满', phone: null, addr: true, err: true },
  { g: '异常', d: '手机号 12 位（多 1 位）', line: `林小满 139000012345 ${A}`, name: '林小满', phone: null, addr: true, err: true },
  { g: '异常', d: '手机号 9 位', line: `林小满 139000012 ${A}`, name: '林小满', phone: null, addr: true, err: true },
  { g: '异常', d: '完全没有手机号', line: `林小满 ${A}`, name: '林小满', phone: null, addr: true, err: true },
  { g: '异常', d: '手机号第二位非法(12)', line: `林小满 12900001234 ${A}`, name: '林小满', phone: null, addr: true, err: true },
  { g: '异常', d: '手机号前 8 位像座机', line: `林小满 0514-86543210 ${A}`, name: '林小满', phone: null, addr: true, err: true },
  { g: '异常', d: '缺姓名只有电话地址', line: `13900001234 ${A}`, name: null, phone: '13900001234', addr: true, err: true },
  { g: '异常', d: '缺地址只有姓名电话', line: `林小满 13900001234`, name: '林小满', phone: '13900001234', addr: false, err: true },
];

const norm = (v) => (v == null ? '' : String(v));
const VERBOSE = process.argv.includes('--all') || process.argv.includes('-v');
let pass = 0;
const fails = [];
const byGroup = {};

for (const c of CASES) {
  const parsed = parseBulkAddresses(c.line);
  const row = parsed[0] ?? {};
  const problems = [];

  if (c.name !== undefined && norm(row.name) !== norm(c.name)) problems.push(`姓名 期望「${c.name}」得到「${row.name}」`);
  if (c.phone !== undefined && norm(row.phone) !== norm(c.phone)) problems.push(`电话 期望「${c.phone}」得到「${row.phone}」`);
  if (c.addr !== undefined && Boolean(norm(row.address)) !== c.addr) problems.push(`地址 ${c.addr ? '应识别' : '不应识别'}，得到「${row.address}」`);
  if (c.err !== undefined && Boolean(row.error) !== c.err) problems.push(`错误标记 期望${c.err ? '有' : '无'}，得到「${row.error || '无'}」`);
  if (c.male !== undefined && Number(row.maleQty) !== c.male) problems.push(`公 期望 ${c.male} 得到「${row.maleQty}」`);
  if (c.female !== undefined && Number(row.femaleQty) !== c.female) problems.push(`母 期望 ${c.female} 得到「${row.femaleQty}」`);
  if (c.copies !== undefined && Number(row.packageCount) !== c.copies) problems.push(`份数 期望 ${c.copies} 得到「${row.packageCount}」`);
  // 地址里不应残留姓名或手机号
  if (row.address && row.name && row.address.includes(row.name)) problems.push('地址里残留了姓名');
  if (row.address && row.phone && row.address.replace(/\D/g, '').includes(row.phone)) problems.push('地址里残留了手机号');

  byGroup[c.g] = byGroup[c.g] ?? { ok: 0, total: 0 };
  byGroup[c.g].total += 1;
  if (problems.length === 0) { pass += 1; byGroup[c.g].ok += 1; }
  else fails.push({ ...c, problems, got: row });

  if (VERBOSE) {
    console.log(`  ${problems.length ? '✗' : '✅'} [${c.g}] ${c.d}`);
    console.log(`      输入：${c.line.replace(/\t/g, '⇥')}`);
    if (problems.length) problems.forEach(p => console.log(`      问题：${p}`));
    else console.log(`      解析：姓名「${norm(row.name) || '—'}」 电话「${norm(row.phone) || '—'}」${row.address ? ` 地址「${row.address}」` : ' 地址「—」'}${row.error ? ` 错误「${row.error}」` : ''}${row.maleQty || row.femaleQty ? ` 数量 ${row.maleQty || 0}公${row.femaleQty || 0}母 ×${row.packageCount ?? 1}份` : ''}`);
  }
}

console.log(`\n批量地址解析自测：${pass}/${CASES.length} 通过\n`);
for (const [g, s] of Object.entries(byGroup)) {
  const bar = s.ok === s.total ? '✅' : '⚠️ ';
  console.log(`  ${bar} ${g.padEnd(6)} ${s.ok}/${s.total}`);
}
if (fails.length) {
  console.log('\n未通过的用例：');
  for (const f of fails) {
    console.log(`\n  ✗ [${f.g}] ${f.d}`);
    console.log(`     输入: ${f.line}`);
    for (const p of f.problems) console.log(`     - ${p}`);
  }
}
console.log(`\n通过率 ${((pass / CASES.length) * 100).toFixed(1)}%`);
process.exit(pass === CASES.length ? 0 : 1);
