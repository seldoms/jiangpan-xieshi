import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import Storefront from './storefront/Storefront'
import AdminApp from './admin/AdminApp'
import GroupPurchase from './group/GroupPurchase'
import { Icon, StateBlock } from './admin/ui'
import { api, isAuthError } from './storefront/api'
import { clearOrderCode, readOrderCode } from './storefront/orderCodeRepository'
// 设计系统统一层必须最后加载：Vite 样式顺序 = import 顺序，放前面会被各模块 CSS 压住。
import './design-system.css'

function App() {
  const params = new URLSearchParams(window.location.search)
  const groupToken = params.get('group')?.trim() || ''
  const [user, setUser] = useState(null)
  // 管理员恢复会话或重新登录时始终回到后台；只有超级管理员可以主动切到店铺预览。
  const [adminMode, setAdminMode] = useState(true)
  // 会话票据在 HttpOnly cookie 里，JS 读不到，所以进入页面就先问一次服务端。
  const [checking, setChecking] = useState(() => !groupToken)
  const [authError, setAuthError] = useState('')
  const [authAttempt, setAuthAttempt] = useState(0)
  const [loginRequired, setLoginRequired] = useState(params.get('view') === 'admin')
  const [sessionVersion, setSessionVersion] = useState(0)
  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)
  const showToast = useCallback((message) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3200)
  }, [])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  const showAdmin = isAdmin && (user.role !== 'superadmin' || adminMode)

  useEffect(() => {
    document.title = showAdmin ? '蟹务台' : '江畔蟹事'
  }, [showAdmin])

  // 刷新时向服务端恢复身份，URL 和本地缓存均不能指定管理员角色。
  // ① 先问会话（HttpOnly cookie）；② 老浏览器里还留着下单码时用它换一次会话，
  // 换到之后就地清掉本地副本 —— 迁完以后下单码就不再落盘了。
  useEffect(() => {
    if (groupToken) return undefined
    let cancelled = false
    setChecking(true)
    setAuthError('')

    async function restore() {
      try {
        const { user: sessionUser } = await api.me()
        if (!cancelled) {
          clearOrderCode()
          setUser(sessionUser)
        }
        return
      } catch (error) {
        // 401/403 = 没有可用会话，属于正常未登录，继续走迁移回退；5xx 才当成故障上报。
        if (error?.status && error.status >= 500) throw error
      }

      const code = readOrderCode()
      if (!code) {
        if (!cancelled) setLoginRequired(true)
        return
      }
      try {
        const { user: currentUser } = await api.login(code)
        if (!cancelled) {
          clearOrderCode()
          setUser(currentUser)
        }
      } catch (error) {
        if (cancelled) return
        if (isAuthError(error)) {
          clearOrderCode()
          setLoginRequired(true)
          return
        }
        throw error
      }
    }

    restore()
      .catch((error) => { if (!cancelled) setAuthError(error.message) })
      .finally(() => { if (!cancelled) setChecking(false) })
    return () => { cancelled = true }
  }, [groupToken, authAttempt])

  const handleLogin = useCallback((currentUser) => {
    setUser(currentUser)
    setAdminMode(true)
    setLoginRequired(false)
    const url = new URL(window.location.href)
    url.searchParams.delete('view')
    url.searchParams.delete('screen')
    window.history.replaceState(null, '', url)
  }, [])

  const logout = useCallback(async () => {
    // 先吊销服务端会话（失败也要清本地，不能把用户卡在登录态里）
    try { await api.logout() } catch { /* 会话可能本来就失效了 */ }
    clearOrderCode()
    setUser(null)
    setAdminMode(true)
    setToast('')
    setLoginRequired(true)
    setSessionVersion((version) => version + 1)
  }, [])

  if (groupToken) return <GroupPurchase token={groupToken} />
  if (checking) return <div className="page-wrap"><StateBlock kind="loading" message="正在恢复登录…" /></div>
  if (authError) return <div className="page-wrap"><StateBlock kind="error" message={authError} onRetry={() => setAuthAttempt((attempt) => attempt + 1)} /></div>

  return <div className="app">{showAdmin
    ? <AdminApp user={user} onToast={showToast} onLogout={logout} onStorefront={user.role === 'superadmin' ? () => setAdminMode(false) : undefined} />
    : <Storefront key={sessionVersion} initialUser={user} initialScreen={loginRequired ? 'login' : undefined} onLogin={handleLogin} onLogout={logout} onAdmin={user?.role === 'superadmin' ? () => setAdminMode(true) : undefined} />}
    {toast && <div className="toast" role="status"><Icon name="check" size={16} />{toast}</div>}
  </div>
}

createRoot(document.getElementById('root')).render(<App />)
