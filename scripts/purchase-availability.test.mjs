import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSpecOrderable, itemsAvailabilityError, selectionAvailabilityError } from '../src/storefront/purchase.js'

const specs = [
  { id: 1, gender: 'male', weightLabel: '4两', orderable: false },
  { id: 2, gender: 'female', weightLabel: '3两', orderable: true },
  { id: 3, gender: 'female', weightLabel: '3.5两', soldOut: true, orderable: true },
]
const config = { specs, templates: [{ id: 1, items: [{ specId: 1, quantity: 5 }, { specId: 2, quantity: 5 }] }] }

test('缺货优先于旧配置的 orderable=true；停售选择必须清除后才能提交', () => {
  assert.equal(isSpecOrderable(specs[2]), false)
  assert.ok(itemsAvailabilityError(specs, [{ specId: 3, qty: 1 }]).includes('缺货'))
  assert.equal(itemsAvailabilityError(specs, [{ specId: 3, qty: 0 }, { specId: 2, qty: 10 }]), '')
})

test('旧套装含下架规格时阻止提交，不能因规格不在当前列表而静默漏单', () => {
  assert.ok(selectionAvailabilityError(config, { mode: 'custom', items: { 99: 5, 2: 5 } }).includes('已下架'))
  assert.equal(selectionAvailabilityError(config, { mode: 'custom', items: { 99: 0, 2: 10 } }), '')
})

test('预设套装按最新规格可售状态判断，停售后禁用、恢复后允许', () => {
  assert.notEqual(selectionAvailabilityError(config, { mode: 'template', templateId: 1 }), '')
  const reopened = { ...config, specs: specs.map(spec => ({ ...spec, orderable: true })) }
  assert.equal(selectionAvailabilityError(reopened, { mode: 'template', templateId: 1 }), '')
  assert.ok(selectionAvailabilityError(config, { mode: 'template', templateId: 99 }).includes('已下架'))
})

test('团购成员快照不决定可售状态；新增、编辑和成团按当前配置校验', () => {
  assert.notEqual(itemsAvailabilityError(specs, [{ specId: 1, qty: 10, orderable: true }]), '')
  assert.equal(itemsAvailabilityError(specs, [{ specId: 2, qty: 10, orderable: false }]), '')
})

test('旧服务端未提供 orderable 时，按中国时区开售边界兜底', () => {
  const openAt = Date.parse('2026-10-01T00:00:00+08:00')
  const male = { gender: 'male' }
  assert.equal(isSpecOrderable(male, openAt - 1), false)
  assert.equal(isSpecOrderable(male, openAt), true)
  assert.equal(isSpecOrderable({ ...male, soldOut: true }, openAt), false)
})
