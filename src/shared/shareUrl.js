/** 分享只携带公开团 token，不沿用当前页面的登录、预览或编辑参数。 */
export function buildShareUrl({ kind = 'shop', token, baseUrl } = {}) {
  // 浏览器里始终使用用户当前正在访问的站点，避免海报二维码被旧配置带去别的域名。
  // baseUrl 只作为非浏览器环境的兼容回退，方便脚本和旧调用继续工作。
  const runtimeUrl = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : baseUrl
  const base = new URL(runtimeUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('分享地址须为 HTTP 或 HTTPS 网站地址')
  const url = new URL('/', base.origin)
  if (kind === 'group') {
    if (typeof token !== 'string' || !token.trim()) throw new Error('缺少团购链接，请重新打开团购')
    url.searchParams.set('group', token)
  }
  return url.href
}

export function isLocalShareUrl(url) {
  const hostname = new URL(url).hostname
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^127\./.test(hostname)
}
