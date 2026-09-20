import { normalizeOrderCode, validateOrderCode } from './loginValidation'

const STORAGE_KEY = 'jiangdu:order-code:v1'

// 下单码即长期身份凭据（bearer 性质），保存在当前浏览器，凭码只能读写自己的订单和草稿。
export function readOrderCode() {
  try {
    const code = localStorage.getItem(STORAGE_KEY) || ''
    return validateOrderCode(code) ? '' : normalizeOrderCode(code)
  } catch {
    return ''
  }
}

export function saveOrderCode(code) {
  if (validateOrderCode(code)) throw new Error('下单码格式不正确')
  localStorage.setItem(STORAGE_KEY, normalizeOrderCode(code))
}

// 下单码失效（服务端 401/403）时清除本地凭据，引导重新登录。
export function clearOrderCode() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch { /* 本地存储不可用时忽略 */ }
}
