import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOX_CAPACITY,
  boxesFor,
  addressAmount,
  allocateFreight,
  allocatePackagingAndFreight,
  isAfterCutoff,
} from '../src/money.js';

// 测试规格价（分/只），与 seed 保持一致
const M4 = 8800; // 公4两
const M35 = 6800; // 公3.5两
const F35 = 9800; // 母3.5两
const F3 = 7800; // 母3两
const PACKAGING = { plain: 0, gift: 1000 };

test('boxesFor: 每盒 10 只，不足 10 只算 1 盒', () => {
  assert.equal(BOX_CAPACITY, 10);
  assert.equal(boxesFor(1), 1);
  assert.equal(boxesFor(8), 1);
  assert.equal(boxesFor(10), 1);
  assert.equal(boxesFor(11), 2);
  assert.equal(boxesFor(15), 2);
  assert.equal(boxesFor(20), 2);
  assert.equal(boxesFor(21), 3);
});

test('boxesFor: count <= 0 或非整数抛错', () => {
  assert.throws(() => boxesFor(0));
  assert.throws(() => boxesFor(-3));
  assert.throws(() => boxesFor(1.5));
});

test('addressAmount: 套餐模式 5公5母混合，每份 10 只', () => {
  const items = [
    { priceCents: M4, qty: 2 },
    { priceCents: M35, qty: 3 },
    { priceCents: F35, qty: 3 },
    { priceCents: F3, qty: 2 },
  ];
  assert.equal(items.reduce((s, i) => s + i.qty, 0), 10);
  const r = addressAmount({ items, copies: 1, packaging: 'gift', packagingPrices: PACKAGING });
  assert.equal(r.boxes, 1);
  assert.equal(r.crabCents, 2 * M4 + 3 * M35 + 3 * F35 + 2 * F3);
  assert.equal(r.packagingCents, 1000);
  assert.equal(r.totalCents, r.crabCents + 1000);
});

test('addressAmount: 一个地址 3 份礼盒，礼盒费按盒数累加 = 3000 分', () => {
  const items = [
    { priceCents: M4, qty: 5 },
    { priceCents: F35, qty: 5 },
  ];
  const r = addressAmount({ items, copies: 3, packaging: 'gift', packagingPrices: PACKAGING });
  assert.equal(r.boxes, 3);
  assert.equal(r.crabCents, (5 * M4 + 5 * F35) * 3);
  assert.equal(r.packagingCents, 3000);
  assert.equal(r.totalCents, r.crabCents + 3000);
});

test('addressAmount: 全公套餐 / 全母套餐各 10 只', () => {
  const allMale = addressAmount({
    items: [{ priceCents: M4, qty: 10 }],
    copies: 1,
    packaging: 'gift',
    packagingPrices: PACKAGING,
  });
  assert.equal(allMale.boxes, 1);
  assert.equal(allMale.crabCents, 10 * M4);
  assert.equal(allMale.packagingCents, 1000);

  const allFemale = addressAmount({
    items: [
      { priceCents: F35, qty: 5 },
      { priceCents: F3, qty: 5 },
    ],
    copies: 2,
    packaging: 'gift',
    packagingPrices: PACKAGING,
  });
  assert.equal(allFemale.boxes, 2);
  assert.equal(allFemale.crabCents, (5 * F35 + 5 * F3) * 2);
  assert.equal(allFemale.packagingCents, 2000);
});

test('addressAmount: 自定义模式按地址总只数计盒，8 只 = 1 盒', () => {
  const r = addressAmount({
    items: [
      { priceCents: M4, qty: 4 },
      { priceCents: F3, qty: 4 },
    ],
    packaging: 'plain',
    packagingPrices: PACKAGING,
  });
  assert.equal(r.boxes, 1);
  assert.equal(r.crabCents, 4 * M4 + 4 * F3);
  assert.equal(r.packagingCents, 0);
});

test('addressAmount: 自定义模式 15 只 = 2 盒，礼盒费 2 盒', () => {
  const r = addressAmount({
    items: [{ priceCents: M35, qty: 15 }],
    packaging: 'gift',
    packagingPrices: PACKAGING,
  });
  assert.equal(r.boxes, 2);
  assert.equal(r.crabCents, 15 * M35);
  assert.equal(r.packagingCents, 2000);
});

test('addressAmount: 包装价可配置', () => {
  const r = addressAmount({
    items: [{ priceCents: M4, qty: 10 }],
    copies: 1,
    packaging: 'gift',
    packagingPrices: { plain: 200, gift: 1500 },
  });
  assert.equal(r.packagingCents, 1500);
});

test('addressAmount: 非法入参抛错', () => {
  assert.throws(() => addressAmount({ items: [] }));
  assert.throws(() => addressAmount({ items: [{ priceCents: -1, qty: 1 }] }));
  assert.throws(() => addressAmount({ items: [{ priceCents: 100, qty: 0 }] }));
  assert.throws(() => addressAmount({ items: [{ priceCents: 1.5, qty: 1 }] }));
  assert.throws(() =>
    addressAmount({ items: [{ priceCents: 100, qty: 1 }], packaging: 'luxury' }),
  );
  assert.throws(() =>
    addressAmount({ items: [{ priceCents: 100, qty: 1 }], copies: 0 }),
  );
});

test('allocateFreight: 除不尽的余数直接抹零（平台承担，无人多付）', () => {
  // 10 / 3 = 3.33…：每人 3 分，抹零 1 分
  assert.deepEqual(allocateFreight(10, [1, 1, 1]), [3, 3, 3]);
  assert.deepEqual(allocateFreight(1, [1, 1]), [0, 0]);
  // 恰好整除时结果不变
  assert.deepEqual(allocateFreight(7, [3, 2, 2]), [3, 2, 2]);
  assert.deepEqual(allocateFreight(100, [50, 50]), [50, 50]);
});

test('allocateFreight: 分摊不上溢（多组随机权重 × 多组金额）', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let round = 0; round < 500; round++) {
    const n = 1 + Math.floor(rand() * 8);
    const weights = Array.from({ length: n }, () => Math.floor(rand() * 20000));
    const total = Math.floor(rand() * 1000000);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const shares = allocateFreight(total, weights);
    const sum = shares.reduce((a, b) => a + b, 0);
    assert.equal(shares.length, n);
    // ① Σ 分摊 <= 总额（抹零，不补齐到总额）
    assert.ok(sum <= total, `sum mismatch: total=${total} weights=${weights} sum=${sum}`);
    // ② 差额只丢分位：严格小于成员数
    assert.ok(
      total - sum < n,
      `remainder too large: total=${total} weights=${weights} sum=${sum}`,
    );
    for (const [i, s] of shares.entries()) {
      assert.ok(Number.isInteger(s) && s >= 0);
      // ③ 任何人都不多付：分摊 <= 精确值
      const exact = totalWeight === 0 ? total / n : (total * weights[i]) / totalWeight;
      assert.ok(
        s <= exact,
        `over-charged: share=${s} exact=${exact} total=${total} weights=${weights}`,
      );
    }
  }
});

test('allocateFreight: 全零重量按份数均分且抹零', () => {
  assert.deepEqual(allocateFreight(10, [0, 0, 0]), [3, 3, 3]);
  assert.deepEqual(allocateFreight(5, [0, 0]), [2, 2]);
});

test('allocatePackagingAndFreight: 包装费 + 运费合并一次分完，两项之和 = 该成员份额', () => {
  // 包装 1000 + 运费 999 = 1999，两份等重：floor(1999/2) = 999，抹零 1 分
  const lines = allocatePackagingAndFreight({
    packagingCents: 1000, freightCents: 999, weights: [1, 1],
  });
  assert.deepEqual(lines, [
    { packagingShareCents: 500, freightShareCents: 499, totalShareCents: 999 },
    { packagingShareCents: 500, freightShareCents: 499, totalShareCents: 999 },
  ]);
  for (const line of lines) {
    assert.equal(line.packagingShareCents + line.freightShareCents, line.totalShareCents);
  }
  assert.equal(lines.reduce((s, l) => s + l.totalShareCents, 0), 1998); // <= 1999
  assert.equal(lines.reduce((s, l) => s + l.packagingShareCents, 0), 1000); // 包装费分完
  assert.equal(lines.reduce((s, l) => s + l.freightShareCents, 0), 998); // 运费抹零 1 分

  // 除不尽：三项都不冒头，各自 <= 精确值
  const uneven = allocatePackagingAndFreight({
    packagingCents: 1000, freightCents: 1000, weights: [1, 1, 1],
  });
  assert.deepEqual(uneven.map((l) => l.totalShareCents), [666, 666, 666]);
  assert.deepEqual(uneven.map((l) => l.packagingShareCents), [333, 333, 333]);
  assert.deepEqual(uneven.map((l) => l.freightShareCents), [333, 333, 333]);
  assert.ok(uneven.every((l) => l.packagingShareCents <= 1000 / 3));
});

test('allocatePackagingAndFreight: 无运费时只分摊包装费，不凭空造运费', () => {
  const lines = allocatePackagingAndFreight({ packagingCents: 7, weights: [1, 1, 1] });
  assert.deepEqual(lines.map((l) => l.freightShareCents), [0, 0, 0]);
  assert.deepEqual(lines.map((l) => l.packagingShareCents), [2, 2, 2]);
  assert.deepEqual(lines.map((l) => l.totalShareCents), [2, 2, 2]);

  // 包装费与运费都为 0 → 全 0，不产生负数
  const zero = allocatePackagingAndFreight({ packagingCents: 0, weights: [0, 0] });
  assert.deepEqual(zero.map((l) => l.totalShareCents), [0, 0]);

  // 非法入参抛错
  assert.throws(() => allocatePackagingAndFreight({ packagingCents: -1, weights: [1] }));
  assert.throws(() => allocatePackagingAndFreight({ packagingCents: 1, freightCents: -1, weights: [1] }));
  assert.throws(() => allocatePackagingAndFreight({ packagingCents: 1, weights: [] }));
});

test('allocateFreight: 非法入参抛错', () => {
  assert.throws(() => allocateFreight(-1, [1]));
  assert.throws(() => allocateFreight(10, []));
  assert.throws(() => allocateFreight(10, [1, -1]));
  assert.throws(() => allocateFreight(10.5, [1]));
});

test('isAfterCutoff: 16:59 可提交，17:00 不可', () => {
  const cutoff = '2026-09-19T09:00:00.000Z'; // 当日 17:00 Asia/Shanghai
  assert.equal(isAfterCutoff('2026-09-19T08:59:59.999Z', cutoff), false); // 16:59:59.999
  assert.equal(isAfterCutoff('2026-09-19T09:00:00.000Z', cutoff), true); // 17:00:00.000
  assert.equal(isAfterCutoff('2026-09-19T09:00:00.001Z', cutoff), true);
  assert.equal(isAfterCutoff('2026-09-18T09:00:00.000Z', cutoff), false);
  assert.equal(isAfterCutoff(new Date('2026-09-19T09:00:00Z'), new Date(cutoff)), true);
});

test('isAfterCutoff: 非法日期抛错', () => {
  assert.throws(() => isAfterCutoff('not-a-date', '2026-09-19T09:00:00Z'));
});
