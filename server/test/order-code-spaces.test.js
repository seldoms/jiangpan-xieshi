import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ORDER_CODE_LENGTH,
  normalizeOrderCode as normalizeServer,
  validateOrderCode as validateServer,
} from '../src/orderCode.js';
import {
  normalizeOrderCode as normalizeFrontend,
  validateOrderCode as validateFrontend,
} from '../../src/storefront/loginValidation.js';

// 前端 validateOrderCode 合法时返回空串，后端返回 null。
const show = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value));

/** 规范化结果（前后端必须逐字相同）。 */
function assertNormalized(value, expected) {
  assert.equal(normalizeFrontend(value), expected, `前端规范化错误：${show(value)}`);
  assert.equal(normalizeServer(value), expected, `后端规范化错误：${show(value)}`);
  assert.equal(
    normalizeFrontend(value),
    normalizeServer(value),
    `前后端规范化结果不一致：${show(value)}`,
  );
}

/**
 * 接受断言：前端直接校验原始输入（表单在提交前会先规范化），
 * 后端按请求头/CLI 的实际链路（先规范化再校验）断言。
 */
function assertAccepted(value, expectedNormalized) {
  assertNormalized(value, expectedNormalized);
  assert.equal(validateFrontend(value), '', `前端不应报错：${show(value)}`);
  assert.equal(
    validateServer(normalizeServer(value)),
    null,
    `后端不应报错（规范化之后）：${show(value)}`,
  );
}

/** 拒绝断言：前后端都必须报错。 */
function assertRejected(value) {
  assert.notEqual(validateFrontend(value), '', `前端应报错：${show(value)}`);
  const normalized = normalizeServer(value);
  assert.notEqual(validateServer(normalized), null, `后端应报错：${show(value)}`);
}

test('中文+字母+数字组合：前后端规范化一致且校验通过', () => {
  const cases = [
    ['张三A1', '张三a1'],
    ['张三a1001', '张三a1001'],
    ['张三', '张三'],
    ['蟹老板B2C3', '蟹老板b2c3'],
    ['测试用户A1', '测试用户a1'],
    ['abc', 'abc'],
    ['ABC123', 'abc123'],
    ['a1', 'a1'],
    ['0', '0'],
    ['ZHANGSAN', 'zhangsan'],
  ];
  for (const [input, expected] of cases) {
    assertAccepted(input, expected);
  }
});

test('前后及中间带半角空格：自动剔除而不是报错', () => {
  const cases = [
    [' 张三A1', '张三a1'],
    ['张三A1 ', '张三a1'],
    ['  张三A1  ', '张三a1'],
    ['张三 A1', '张三a1'],
    ['张 三 A 1', '张三a1'],
    ['张三   a1001', '张三a1001'],
    ['abc 123', 'abc123'],
    [' A ', 'a'],
  ];
  for (const [input, expected] of cases) {
    assertAccepted(input, expected);
  }
  // 多个连续空格不会残留
  assertNormalized('  a   b  ', 'ab');
});

test('全角空格 U+3000：自动剔除而不是报错', () => {
  const cases = [
    ['\u3000张三A1', '张三a1'],
    ['张三A1\u3000', '张三a1'],
    ['\u3000\u3000张三\u3000A1\u3000\u3000', '张三a1'],
    ['张三\u3000\u3000a1001', '张三a1001'],
    ['a\u30001', 'a1'],
  ];
  for (const [input, expected] of cases) {
    assertAccepted(input, expected);
  }
});

test('制表符、换行、回车等 ASCII 空白：自动剔除而不是报错', () => {
  const cases = [
    ['\t张三A1', '张三a1'],
    ['张三A1\n', '张三a1'],
    ['张三A1\r\n', '张三a1'],
    ['\v张三A1\f', '张三a1'],
    ['张\t三\nA\r1', '张三a1'],
  ];
  for (const [input, expected] of cases) {
    assertAccepted(input, expected);
  }
  assertNormalized(' \t\n\r\v\f ', '');
  assert.notEqual(validateFrontend(' \t\n\r\v\f '), '', '纯空白应报错');
});

test('其他 Unicode 空白：自动剔除而不是报错', () => {
  const cases = [
    [0x00a0, '不换行空格 NBSP'],
    [0x1680, 'OGHAM 空格'],
    [0x2003, 'EM 空格'],
    [0x2007, '数字空格'],
    [0x2028, '行分隔符'],
    [0x2029, '段分隔符'],
    [0x202f, '窄不换行空格'],
    [0x205f, '数学空格'],
    [0x3000, '全角空格'],
    [0xfeff, '零宽不换行空格 BOM'],
    [0x0085, 'NEL'],
  ];
  for (const [codePoint, label] of cases) {
    const space = String.fromCodePoint(codePoint);
    assertAccepted(`张${space}三A1`, '张三a1');
    assertAccepted(`${space}张三A1${space}`, '张三a1');
    assert.equal(
      validateFrontend(`张三A1${space}`),
      '',
      `${label} (U+${codePoint.toString(16).toUpperCase()}) 不应导致报错`,
    );
  }
  assertRejected('张三\u200bA1'); // 零宽空格不是 Unicode 空白，按非法符号处理
});

test('全角数字与全角字母折成半角', () => {
  const cases = [
    ['张三ＡＢＣ１２３', '张三abc123'],
    ['ａ１', 'a1'],
    ['Ａ', 'a'],
    ['Ｚｚ０９', 'zz09'],
    ['１００１', '1001'],
    ['张三ａ1001', '张三a1001'],
  ];
  for (const [input, expected] of cases) {
    assertAccepted(input, expected);
  }
});

test('大小写混合统一转小写', () => {
  const cases = [
    ['ZhaNgSanA1', 'zhangsana1'],
    ['ABC', 'abc'],
    ['aBc123XYZ', 'abc123xyz'],
  ];
  for (const [input, expected] of cases) {
    assertAccepted(input, expected);
  }
});

test('空白 + 全角 + 大小写混合的组合输入', () => {
  assertAccepted('\u3000张 三 Ａ１\ufeff ', '张三a1');
  assertAccepted(' ＺＨＡＮＧ  Ｓａｎ\u3000A１\t', 'zhangsana1');
  assertAccepted('\t张三\u2003ＡＢＣ\u3000１２３\r\n', '张三abc123');
});

test('超长下单码（>64 字符）应报错', () => {
  const limit = MAX_ORDER_CODE_LENGTH;
  assert.equal(limit, 64);

  assertAccepted('a'.repeat(limit), 'a'.repeat(limit));
  assertAccepted('张三'.repeat(limit / 2), '张三'.repeat(limit / 2));

  assertRejected('a'.repeat(limit + 1));
  assertRejected('张'.repeat(limit + 1));
  assertRejected('张三'.repeat(limit));
  // 空白剔除后仍然超长 → 报错
  assertRejected(`${'a'.repeat(limit + 1)}   `);
  // 空白填充不应把合法长度“撑”成超长
  assertAccepted(`  ${'a'.repeat(limit)}\u3000`, 'a'.repeat(limit));
});

test('非法符号（emoji、标点等）应报错', () => {
  const cases = [
    '张三😀',
    '😀',
    '张三,',
    '张三。',
    '张三，',
    '张三、',
    'zhang-san',
    'zhang_san',
    '张三A1!',
    '张三A1@#',
    '张三Ａ１，', // 全角标点不属于全角字母范围
    '张三／',
    '/张三',
    '张三\\A1',
    '张三＂A1',
    'a b c 张',  // 中间空格被剔除，但仍是合法字符 → 见下一断言
  ];
  for (const input of cases.slice(0, -1)) {
    assertRejected(input);
  }
  // 只含中文、字母、数字与空白 → 剔除空白后合法
  assertAccepted('a b c 张', 'abc张');
});

test('空串与纯空白应报错', () => {
  for (const input of ['', ' ', '   ', '\u3000', '\t', '\n', '\u3000 \t\n', '\u00a0\ufeff']) {
    assert.notEqual(validateFrontend(input), '', `前端应报错：${show(input)}`);
    assert.notEqual(validateServer(normalizeServer(input)), null, `后端应报错：${show(input)}`);
    assert.equal(normalizeServer(input), '');
  }
  assert.equal(validateFrontend(''), '请输入下单码。');
  assert.equal(normalizeFrontend('   '), '');
});

test('非字符串输入一律视为空', () => {
  for (const input of [null, undefined, 123, {}, [], true]) {
    assert.equal(normalizeFrontend(input), '');
    assert.equal(normalizeServer(input), '');
    assert.equal(validateFrontend(input), '请输入下单码。');
    assert.notEqual(validateServer(normalizeServer(input)), null);
  }
});

test('规范化是幂等的', () => {
  const samples = [' 张三 A1 ', '\u3000ＡＢＣ１２３\ufeff', '张\t三\nA1', ' zhangsan '];
  for (const sample of samples) {
    const once = normalizeFrontend(sample);
    assert.equal(normalizeFrontend(once), once);
    assert.equal(normalizeServer(once), once);
    assert.equal(normalizeFrontend(sample), normalizeServer(sample));
  }
});

test('请求头 URL 编码往返后再规范化（decodeURIComponent 兼容）', () => {
  const cases = [
    ['张三 A1', '张三a1'],
    ['张三\u3000A1', '张三a1'],
    [' 张三a1001 ', '张三a1001'],
    ['ＡＢＣ １２３', 'abc123'],
  ];
  for (const [raw, expected] of cases) {
    // 与 src/plugins/auth.js 的链路一致：encodeURIComponent → decodeURIComponent → normalize
    const received = decodeURIComponent(encodeURIComponent(raw));
    assert.equal(normalizeServer(received), expected, `URL 编码往返后规范化错误：${show(raw)}`);
    assert.equal(validateServer(normalizeServer(received)), null, `请求头链路不应报错：${show(raw)}`);
    assert.equal(normalizeFrontend(received), expected);
  }
});

test('前后端规范化实现在同一批样例上逐字相等', () => {
  const samples = [
    '张三A1', '张三A1 ', ' 张三 A1 ', '\u3000张三\u3000A1\u3000', '\t张三A1\n',
    'ＡＢＣ１２３', 'ａ１', 'Ｚｚ０９', 'ZhaNgSanA1', '蟹老板B2C3',
    '  ZhaNgSan Ａ１\u3000', '1234', '张 三 1 2 3', 'a'.repeat(80),
  ];
  for (const sample of samples) {
    assert.equal(
      normalizeFrontend(sample),
      normalizeServer(sample),
      `前后端规范化不一致：${show(sample)}`,
    );
  }
});
