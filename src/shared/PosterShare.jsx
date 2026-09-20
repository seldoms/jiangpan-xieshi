import { useEffect, useId, useRef, useState } from 'react'
import { buildShareUrl, isLocalShareUrl } from './shareUrl'
import { renderPoster } from './posterRenderer'
import './poster-share.css'

export default function PosterShare({ kind = 'shop', token, title, baseUrl, onClose }) {
  const [poster, setPoster] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [copying, setCopying] = useState(false)
  const dialogRef = useRef(null)
  const closeRef = useRef(null)
  const linkRef = useRef(null)
  const onCloseRef = useRef(onClose)
  const fullscreenRef = useRef(fullscreen)
  const titleId = useId()
  onCloseRef.current = onClose
  fullscreenRef.current = fullscreen
  let url = '', urlError = ''
  try { url = buildShareUrl({ kind, token, baseUrl }) } catch (err) { urlError = err.message }

  useEffect(() => {
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (fullscreenRef.current) setFullscreen(false)
        else onCloseRef.current()
      }
      if (event.key === 'Tab') {
        const controls = [...dialogRef.current.querySelectorAll('button:not(:disabled), a[href], input, [tabindex="0"]')]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKey)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    let cancelled = false, objectUrl
    setPoster(null)
    setError('')
    setMessage('')
    if (url) renderPoster({ kind, url, title }).then(blob => {
      if (cancelled) return
      sessionStorage.removeItem('jiangdu:chunk-reload')
      objectUrl = URL.createObjectURL(blob)
      setPoster({ blob, src: objectUrl })
    }).catch(err => {
      if (cancelled) return
      const message = String(err?.message || '')
      // 部署换了 hash 之后，还开着的旧页面去请求已删除的 chunk 会拿到
      // 「Failed to fetch dynamically imported module」。海报渲染器已改成静态引入 qrcode
      // 根治这条路径，这里再兜一层：命中就自动刷新一次拿新 bundle
      // （sessionStorage 打标记防死循环；生成成功时清掉，下次部署仍能救）。
      const isStaleChunk = /dynamically imported module|Importing a module script failed|Loading chunk/i.test(message)
      if (isStaleChunk && !sessionStorage.getItem('jiangdu:chunk-reload')) {
        sessionStorage.setItem('jiangdu:chunk-reload', '1')
        location.reload()
        return
      }
      setError(message || '海报生成失败，请重试')
    })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [kind, url, title, attempt])

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(url); setMessage('链接已复制') }
    catch { linkRef.current?.focus(); linkRef.current?.select(); setMessage('请复制已选中的链接') }
  }
  const copyImage = async () => {
    if (!poster || copying) return
    setCopying(true)
    try {
      if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('unsupported')
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': poster.blob })])
      setMessage('海报已复制，可粘贴分享')
    } catch { setMessage('此浏览器不支持复制图片，请保存或长按海报'); }
    finally { setCopying(false) }
  }

  const failure = urlError || error
  return <div className={`poster-backdrop${fullscreen ? ' poster-fullscreen' : ''}`} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="poster-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
      <header className="poster-toolbar"><h2 id={titleId}>{kind === 'group' ? '团购海报' : '分享海报'}</h2><button ref={closeRef} type="button" aria-label={fullscreen ? '退出全屏' : '关闭海报'} onClick={() => fullscreen ? setFullscreen(false) : onClose()}>×</button></header>
      <div className="poster-image-area">
        {failure ? <div className="poster-state" role="alert"><p>{failure}</p>{!urlError && <button type="button" onClick={() => setAttempt(value => value + 1)}>重新生成</button>}</div>
          : poster ? <img className="poster-image" src={poster.src} alt={kind === 'group' ? `${title || '团购'}邀请海报，扫码进入本团` : '江都大闸蟹海报，扫码进入下单页'} role={fullscreen ? undefined : 'button'} tabIndex={fullscreen ? undefined : 0} aria-label={fullscreen ? undefined : '全屏查看海报'} onClick={() => { if (!fullscreen) setFullscreen(true) }} onKeyDown={event => { if (!fullscreen && ['Enter', ' '].includes(event.key)) { event.preventDefault(); setFullscreen(true) } }} />
            : <p className="poster-state" role="status">正在生成海报…</p>}
      </div>
      {!fullscreen && <div className="poster-link-row"><input ref={linkRef} readOnly aria-label="分享链接" value={url} onFocus={event => event.target.select()} /><button type="button" disabled={!url} onClick={copyLink}>复制链接</button></div>}
      <footer className="poster-actions">
        {!fullscreen && <button type="button" disabled={!poster || copying} onClick={copyImage}>{copying ? '复制中…' : '复制海报'}</button>}
        {poster && <a href={poster.src} download={`江畔蟹事-${kind === 'group' ? '团购' : '首页'}海报.png`} onClick={() => setMessage('也可以长按图片保存')}>保存图片</a>}
        {poster && !fullscreen && <button type="button" onClick={() => setFullscreen(true)}>全屏查看</button>}
      </footer>
      {url && isLocalShareUrl(url) && <p className="poster-local-note">当前为本机预览码；对外分享前请在后台设置分享域名。</p>}
      <p className="poster-message" role="status">{message || (poster ? '点击看大图 · 长按可保存' : '')}</p>
    </section>
  </div>
}
