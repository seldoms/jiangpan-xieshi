import { useEffect, useRef, useState } from 'react'
import { AssetIcon } from './ImageSlot'
import { ApiError, api } from './api'
import { normalizeOrderCode, validateOrderCode } from './loginValidation'
import { readOrderCode } from './orderCodeRepository'
import './login.css'

export default function LoginPage({ onBack, onLogin }) {
  const [orderCode, setOrderCode] = useState(readOrderCode)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [user, setUser] = useState(null)
  const inputRef = useRef(null)
  const resultRef = useRef(null)

  useEffect(() => {
    if (user) resultRef.current?.focus()
  }, [user])

  async function submit(event) {
    event.preventDefault()
    const message = validateOrderCode(orderCode)
    if (message) {
      setError(message)
      inputRef.current?.focus()
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const code = normalizeOrderCode(orderCode)
      const data = await api.login(code)
      // 登录后身份由服务端签发的 HttpOnly 会话承载，不再把下单码写进 localStorage。
      setOrderCode(code)
      setUser(data.user)
      onLogin?.(data.user)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后重试。')
      inputRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  return <section className="jd-login" aria-label="下单码">
    <div className="jd-login-topline"><button type="button" className="jd-link" onClick={onBack}><AssetIcon name="arrow-left" />返回逛逛</button></div>
    <div className="jd-login-layout">
      <div className="jd-login-card">
        {user ? <div className="jd-login-result">
          <span className="jd-login-result-mark"><AssetIcon name="check" size={26} /></span>
          <h1 ref={resultRef} tabIndex={-1}>欢迎回来，{user.displayName}</h1>
          <p className="jd-order-code-value">{orderCode}</p>

          <button type="button" className="jd-button" onClick={onBack}>继续逛逛<AssetIcon name="arrow-right" /></button>
          <small className="jd-order-code-note">下单码即身份凭据，请妥善保管，不要发给他人</small>
        </div> : <>
          <div className="jd-login-heading"><h1>下单码</h1></div>
          <form className="jd-login-form" onSubmit={submit} noValidate>
            <div className={`jd-login-input${error ? ' has-error' : ''}`}>
              <input ref={inputRef} id="jd-order-code" name="orderCode" type="text" aria-label="下单码" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} required value={orderCode} placeholder="首次使用自定一个，如张三A1" aria-invalid={Boolean(error)} aria-describedby={error ? 'jd-order-code-error' : undefined} onChange={event => { setOrderCode(event.target.value); setError('') }} />
            </div>
            {error && <p className="jd-login-error" id="jd-order-code-error" role="alert">{error}</p>}
            <button type="submit" className="jd-button jd-login-submit" disabled={submitting}>{submitting ? '验证中…' : '登录'}<AssetIcon name="arrow-right" /></button>
          </form>
        </>}
      </div>
    </div>
  </section>
}
