import { readOrderCode } from './orderCodeRepository'

// 开发环境默认走 Vite proxy；正式前后端分离部署时由 VITE_API_BASE_URL 注入。
const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

async function request(path, { method = 'GET', body, auth = true, headers: extraHeaders = {} } = {}) {
  const headers = { Accept: 'application/json', ...extraHeaders }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth) {
    const orderCode = readOrderCode()
    // HTTP header 只能可靠承载 ASCII；下单码允许中文，先编码后由服务端解码。
    if (orderCode) headers['X-Order-Code'] = encodeURIComponent(orderCode)
  }

  let response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      // 会话票据放在 HttpOnly cookie 里，同源请求自动携带；显式声明避免以后跨域部署踩空。
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('NETWORK_ERROR', '网络连接失败，请稍后重试。', 0)
  }

  if (response.status === 204) return null
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const error = data?.error ?? {}
    throw new ApiError(
      error.code ?? `HTTP_${response.status}`,
      error.message ?? '请求失败，请稍后重试。',
      response.status,
    )
  }
  return data
}

// 金额一律为整数分；展示元 = cents / 100，保留两位小数。
export function formatCents(cents) {
  const value = Number(cents ?? 0)
  return ((Number.isFinite(value) ? value : 0) / 100).toFixed(2)
}

export function formatYuan(cents) {
  return `¥ ${formatCents(cents)}`
}

export function isAuthError(error) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403)
}

export const api = {
  login: (orderCode) => request('/auth/login', { method: 'POST', body: { orderCode }, auth: false }),
  // 会话查询只认 cookie，因此不带下单码头（否则请求头会掩盖真实的会话状态）。
  me: () => request('/auth/me', { auth: false }),
  logout: () => request('/auth/logout', { method: 'POST', auth: false }),
  getCurrentConfig: () => request('/config/current'),
  createOrder: (payload) => request('/orders', { method: 'POST', body: payload }),
  listOrders: () => request('/orders'),
  getOrder: (id) => request(`/orders/${id}`),
  getRepurchaseConfig: (id) => request(`/orders/${id}/repurchase-config`),
  listCartDrafts: () => request('/cart/drafts'),
  createCartDraft: (payload) => request('/cart/drafts', { method: 'POST', body: { payload } }),
  updateCartDraft: (id, payload) => request(`/cart/drafts/${id}`, { method: 'PUT', body: { payload } }),
  deleteCartDraft: (id) => request(`/cart/drafts/${id}`, { method: 'DELETE' }),
  createGroup: (title, initialMember) => request('/groups', { method: 'POST', body: { title, initialMember } }),
  listMyGroups: () => request('/groups/mine'),
  deleteGroup: (token) => request(`/groups/${encodeURIComponent(token)}`, { method: 'DELETE' }),
}
