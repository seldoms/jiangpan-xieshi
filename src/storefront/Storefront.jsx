import { useCallback, useEffect, useRef, useState } from 'react'
import ImageSlot, { AssetIcon } from './ImageSlot'
import ImageAtlasBoard from './ImageAtlasBoard'
import LoginPage from './LoginPage'
import Home from './Home'
import MyGroups from './MyGroups'
import SpecBadge from '../shared/SpecBadge'
import PosterShare from '../shared/PosterShare'
import { buildShareUrl } from '../shared/shareUrl'
import { ApiError, api, formatCents, formatYuan, isAuthError } from './api'
import { BOX_CAPACITY, PLAIN_PACKAGING_ENABLED, buildShipmentsPayload, calculatePurchase, configLabel, couponActivityHint, couponPreview, defaultSelection, draftEntries, findDuplicateConfig, findTemplate, formatBatchSchedule, isSpecOrderable, packagingLabel, selectionItems, specClosedReason, specLabel, selectionAvailabilityError, itemsAvailabilityError } from './purchase'
import { parseBulkAddresses } from './addressParser'
import { createDraft, deleteDraft, emptyCartAddresses, listDrafts, readDraftPayload, updateDraft } from './cartRepository'
import { clearOrderCode, readOrderCode } from './orderCodeRepository'
import { NOTICE_DURATION_MS, markNoticeSeen, shouldShowNotice } from './noticeRepository'
import { saveEditKey } from '../group/credentials'

// 与后端 orderRepo 的手机号校验规则保持一致：11 位、1 开头、第二位 3-9。
const PHONE_PATTERN = /^1[3-9]\d{9}$/
import './storefront.css'
import './image-layout.css'
import './desktop.css'
import './home.css'
import './minimal.css'

// ---------- 公告（服务端 GET /api/v1/config/notice）----------
// 与内置「购买须知」横幅同一套展示纪律：当天一次、自动消失、X 可手动关闭。
const ANNOUNCEMENT_SEEN_KEY = 'jiangdu:notice:seen:v1'
const ANNOUNCEMENT_DURATION_MS = 10000
// 接口还没发布时可能 404／超时：绝不能因此拖慢或影响页面，超时后静默当没有公告。
const ANNOUNCEMENT_TIMEOUT_MS = 2500
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '')

function shanghaiDateLabel() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

// 公告的「已看过」印记 = 当天日期 + 内容指纹：内容改了（指纹变了）就重新展示一次。
function announcementStamp(content) {
  let hash = 0
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) | 0
  }
  return `${shanghaiDateLabel()}:${(hash >>> 0).toString(36)}`
}

function shouldShowAnnouncement(content) {
  try {
    return localStorage.getItem(ANNOUNCEMENT_SEEN_KEY) !== announcementStamp(content)
  } catch {
    // 隐私模式读不到就退化为每次都展示，不能因为存储问题把公告吞掉。
    return true
  }
}

function markAnnouncementSeen(content) {
  try {
    localStorage.setItem(ANNOUNCEMENT_SEEN_KEY, announcementStamp(content))
  } catch {
    // 写不进去就退化为每次访问都展示
  }
}

const ORDER_STATUS_LABELS = { submitted: '已提交' }
const SHIPMENT_STATUS_LABELS = { fishing: '捕捞中', packed: '已打包', shipped: '已发货' }
const orderStatusLabel = (status) => ORDER_STATUS_LABELS[status] ?? status
const shipmentStatusLabel = (status) => SHIPMENT_STATUS_LABELS[status] ?? status

function formatTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

function Arrow({ back = false }) {
  return <AssetIcon name={back ? 'arrow-left' : 'arrow-right'} />
}

function BagIcon() {
  return <AssetIcon name="bag" />
}

function Brand({ onClick }) {
  return <button className="jd-brand" onClick={onClick} aria-label="江畔蟹事，返回首页"><ImageSlot id="C01" compact eager /><span><strong>江畔蟹事</strong><small>一方水土 · 一季好蟹</small></span></button>
}

function QuantityControl({ label, value, onChange, disabled = false }) {
  return <div className={`jd-quantity${disabled ? ' is-disabled' : ''}`} role="group" aria-label={`${label}数量`}><button type="button" aria-label={`减少${label}`} disabled={value === 0} onClick={() => onChange(value - 1)}>−</button><output aria-label={`${label}只数`}>{value}</output><button type="button" aria-label={`增加${label}`} disabled={disabled || value === 99} onClick={() => onChange(value + 1)}>+</button></div>
}

function SpecsGuideDialog({ onClose }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose() }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return <div className="jd-spec-guide-overlay" role="dialog" aria-modal="true" aria-labelledby="jd-spec-guide-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="jd-spec-guide-dialog">
      <header><div><h2 id="jd-spec-guide-title">看图选规格</h2></div><button type="button" className="jd-spec-guide-close" onClick={onClose} aria-label="关闭规格说明">×</button></header>
      <div className="jd-spec-guide-body">
        <img src="/assets/jiangdu-v1/guides/crab-specs-gender.webp?v=20260920-reference-v3" alt="大闸蟹公母腹面和三两至五两规格对比" />
      </div>
    </div>
  </div>
}

function Selection({ config, selection, setSelection, onPickTemplate, groupMode = false }) {
  const [guideOpen, setGuideOpen] = useState(false)
  const specs = config?.specs ?? []
  const templates = config?.templates ?? []
  const hasTemplates = !groupMode && templates.length > 0
  const isTemplate = selection?.mode === 'template' && hasTemplates
  return <>
    {groupMode && <h2 className="jd-compact-title">我的搭配</h2>}
    {hasTemplates && <div className="jd-mode-switch-wrap">
      <div className="jd-mode-switch" role="tablist" aria-label="选购方式">
        <button type="button" role="tab" aria-selected={isTemplate} className={isTemplate ? 'is-active' : ''} onClick={() => setSelection(current => ({ ...current, mode: 'template', templateId: current.templateId ?? templates[0].id }))}>预设套装</button>
        <button type="button" role="tab" aria-selected={!isTemplate} className={!isTemplate ? 'is-active' : ''} onClick={() => setSelection(current => ({ ...current, mode: 'custom' }))}>自定义套装</button>
      </div>
    </div>}
    <button type="button" className="jd-guide-link" onClick={() => setGuideOpen(true)} aria-haspopup="dialog"><AssetIcon name="info" />规格图解</button>
    <section className="jd-selection-card">
      {isTemplate ? <div className="jd-template-grid">{templates.map(template => {
        // 今年只有礼盒：模板自带「普通包装」的，卡片标「暂不提供」并置灰不可选。
        // 已经选中的（旧草稿/回填）保留原样，不主动清掉。
        const plainClosed = template.packaging === 'plain' && !PLAIN_PACKAGING_ENABLED
        const availabilityError = selectionAvailabilityError(config, { mode: 'template', templateId: template.id })
        const disabled = plainClosed || Boolean(availabilityError)
        return <label className={`jd-package-option${selection.templateId === template.id ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`} key={template.id} onClick={() => { if (disabled) return; setSelection(current => ({ ...current, templateId: template.id })); onPickTemplate?.(); }}>
        <input type="radio" name="package-template" value={template.id} checked={selection.templateId === template.id} disabled={disabled} onChange={() => setSelection(current => ({ ...current, templateId: template.id }))} />
        <span className="jd-package-copy"><strong>{template.name}</strong>{availabilityError && <span className="jd-template-unavailable">{availabilityError}</span>}{!groupMode && <em className="jd-template-tag">{packagingLabel(template.packaging)}{plainClosed ? ' · 暂不提供' : ''}</em>}<span className="jd-inline-specs">{template.items.map(item => <span key={item.specId}><SpecBadge gender={item.gender} weightLabel={item.weightLabel} compact /> × {item.quantity}</span>)}</span><em className="jd-template-price">{formatYuan(template.crabCentsPerCopy)} / 份</em></span>
        <span className="jd-radio" aria-hidden="true" />
      </label>})}</div> : <div className="jd-selection-items">{specs.map(spec => {
        // 不可售规格禁止增加，旧选择保留并允许减去，避免用户无法修正旧套装。
        const orderable = isSpecOrderable(spec)
        const quantity = selection?.items?.[spec.id] ?? 0
        return <div className={`jd-selection-item${orderable ? '' : ' is-disabled'}`} key={spec.id}>
        <SpecBadge gender={spec.gender} weightLabel={spec.weightLabel} />
        <span className="jd-spec-meta"><strong className="jd-spec-price">{formatYuan(spec.priceCents)}<small> / 只</small></strong>{!orderable && <em className="jd-spec-closed">{specClosedReason(spec)}</em>}</span>
        <QuantityControl label={specLabel(spec)} value={quantity} disabled={!orderable} onChange={value => setSelection(current => ({ ...current, items: { ...current.items, [spec.id]: value } }))} />
      </div>})}</div>}
    </section>
    {selection?.mode !== 'template' && Object.entries(selection?.items ?? {}).filter(([id, qty]) => Number(qty) > 0 && !specs.some(spec => spec.id === Number(id))).map(([id, qty]) => <p className="jd-helper" key={id}>原规格已下架（{qty} 只） <button type="button" className="jd-button-plain" onClick={() => setSelection(current => ({ ...current, items: { ...current.items, [id]: 0 } }))}>移除并重新搭配</button></p>)}
    {guideOpen && <SpecsGuideDialog onClose={() => setGuideOpen(false)} />}
  </>
}

function AddressForm({ config, selection, entries, cartPackaging, addresses, setAddresses, totals, bulkText, setBulkText, parsedAddresses, setParsedAddresses, onImport }) {
  // 一条地址收起为一张小卡片，改细节点开弹窗——一屏能扫完，有问题一眼看得见。
  const [editingId, setEditingId] = useState(null)
  const editingIndex = addresses.findIndex(entry => entry.id === editingId)
  const editingEntry = editingIndex >= 0 ? addresses[editingIndex] : null
  const entryOf = (address) => entries?.find(item => item.id === address?.configId) ?? entries?.[0] ?? null
  const update = (id, field, value) => setAddresses(current => current.map(entry => entry.id === id ? { ...entry, [field]: value, parseError: '' } : entry))
  // 解析结果带上原始行号；预览时把有问题的行排到最前面，方便逐条修。
  const parse = () => setParsedAddresses(parseBulkAddresses(bulkText).map((entry, index) => ({ ...entry, line: index + 1 })))
  const problemCount = parsedAddresses.filter(entry => entry.error).length
  const orderedParsed = [...parsedAddresses].sort((a, b) => (b.error ? 1 : 0) - (a.error ? 1 : 0))
  const templatePackaging = selection?.mode === 'template' ? packagingLabel(findTemplate(config, selection.templateId)?.packaging) : null
  const giftPrice = config?.packagingPrices?.gift ?? 0
  return <>
    <div className="jd-form-heading"><h1>收货信息</h1></div>
    {/* 份数只说一次、且只在真正要填地址的这一页说：选蟹页不该出现地址/份数/盒数 */}
    <p className="jd-helper jd-address-summary">配置 {addresses.length} 份，{addresses.length > 1 ? '分别寄到以下地址' : '寄到以下地址'}</p>
    <section className="jd-bulk-import" aria-labelledby="jd-bulk-title">
      <div className="jd-bulk-heading"><h2 id="jd-bulk-title">批量粘贴</h2></div>
      <textarea aria-label="批量收货信息" value={bulkText} onChange={event => { setBulkText(event.target.value); setParsedAddresses([]) }} placeholder="每行一条，例如：林小满 13900001234 江都区水乡路18号（姓名、电话、地址顺序不限。规格和数量在选蟹页选）" />
      <button type="button" className="jd-bulk-parse" onClick={parse}>解析并预览</button>
      {parsedAddresses.length > 0 && <div className="jd-bulk-preview"><div className="jd-bulk-preview-head"><strong>识别到 {parsedAddresses.length} 条</strong><span className={problemCount ? 'has-problem' : ''}>{problemCount ? `${problemCount} 条待修正，可先导入再改` : '全部可导入'}</span></div>{orderedParsed.map((entry) => <div className={`jd-bulk-row${entry.error ? ' has-error' : ''}`} key={`${entry.raw}-${entry.line}`}><b>{entry.line}</b><div><strong>{entry.name || '未识别姓名'} · {entry.phone || '未识别电话'}</strong><small>{entry.error ? `⚠ ${entry.error}` : entry.address}</small></div><em>份数 1</em></div>)}<button type="button" className="jd-bulk-confirm" onClick={() => onImport(parsedAddresses)}>{problemCount ? `先导入 ${parsedAddresses.length} 条（${problemCount} 条待修正）` : `确认导入 ${parsedAddresses.length} 个地址`}</button></div>}
    </section>
    <div className="jd-addresses">{addresses.map((entry, index) => {
      const preview = totals.shipments[index]
      const entryConfigLabel = configLabel(config, entryOf(entry))
      const packagingText = packagingLabel(preview?.packaging ?? cartPackaging)
      return <article className={`jd-address-card${entry.parseError ? ' has-problem' : ''}`} key={entry.id} data-address-index={index}>
        <div className="jd-address-top">
          <strong>收货地址 {String(index + 1).padStart(2, '0')}</strong>
          <span className="jd-address-tags">
            <em className="jd-address-config">{entryConfigLabel}</em>
            <em>{packagingText}</em>
            {preview && <em className="jd-address-money">{formatYuan(preview.totalCents)}</em>}
          </span>
        </div>
        <button type="button" className="jd-address-lines" onClick={() => setEditingId(entry.id)} aria-label={`修改收货地址 ${index + 1}`}>
          <span className="jd-address-who"><b>{entry.name || '未填收货人'}</b><span>{entry.phone || '未填手机号'}</span></span>
          <span className="jd-address-where">{entry.address || '未填详细地址'}</span>
        </button>
        {entry.parseError && <p className="jd-field-problem" role="alert">⚠ {entry.parseError}</p>}
        <div className="jd-address-actions">
          <button type="button" className="jd-address-edit" onClick={() => setEditingId(entry.id)}>修改</button>
          {addresses.length > 1 && <button type="button" className="jd-address-remove" onClick={() => setAddresses(current => current.filter(address => address.id !== entry.id))}>移除</button>}
        </div>
      </article>
    })}</div>
    <button type="button" className="jd-add-address" onClick={() => setAddresses(current => [...current, { id: crypto.randomUUID(), name: '', phone: '', address: '', configId: entries?.[0]?.id ?? null, packaging: '' }])}><span>＋</span>添加地址</button>
    {editingEntry && <div className="jd-address-modal" role="dialog" aria-modal="true" aria-label={`修改收货地址 ${editingIndex + 1}`}>
      <div className="jd-address-modal-mask" onClick={() => setEditingId(null)} />
      <div className="jd-address-modal-panel">
        <div className="jd-address-modal-head">
          <h3>收货地址 {String(editingIndex + 1).padStart(2, '0')}</h3>
          <button type="button" className="jd-modal-close" onClick={() => setEditingId(null)} aria-label="关闭修改窗口"><AssetIcon name="close" size={18} /></button>
        </div>
        <div className="jd-address-modal-body">
          <label>收货人<input autoComplete="section-recipient name" maxLength={40} value={editingEntry.name || ''} onChange={event => update(editingEntry.id, 'name', event.target.value)} placeholder="收货人姓名" /></label>
          <label>手机号码<input autoComplete="section-recipient tel" type="tel" inputMode="tel" maxLength={11} value={editingEntry.phone || ''} onChange={event => update(editingEntry.id, 'phone', event.target.value.replace(/\D/g, ''))} placeholder="11 位手机号码" /></label>
          <label className="jd-address-wide">详细地址<input autoComplete="section-recipient street-address" maxLength={200} value={editingEntry.address || ''} onChange={event => update(editingEntry.id, 'address', event.target.value)} placeholder="省 / 市 / 区，街道及门牌号" /></label>
          <div className="jd-address-modal-meta">
            {entries?.length > 1 && <label>螃蟹配置<span className="jd-mini-options" role="radiogroup" aria-label="螃蟹配置">
              {entries.map(item => <button type="button" key={item.id} className={`jd-mini-option${(editingEntry.configId ?? entries[0]?.id) === item.id ? ' is-selected' : ''}`} aria-pressed={(editingEntry.configId ?? entries[0]?.id) === item.id} onClick={() => update(editingEntry.id, 'configId', item.id)}>{configLabel(config, item)}</button>)}
            </span></label>}
            <label>包装<span className="jd-mini-options" role="radiogroup" aria-label="包装方式">
              <button type="button" className={`jd-mini-option${!editingEntry.packaging ? ' is-selected' : ''}`} aria-pressed={!editingEntry.packaging} onClick={() => update(editingEntry.id, 'packaging', '')}>跟随套装（{packagingLabel(cartPackaging)}）</button>
              {['gift', 'plain'].map(option => {
                // 今年只出礼盒：普通包装保留在列表里但置灰、点不了，小字标注「暂不提供」。
                // 明年恢复时把 purchase.js 的 PLAIN_PACKAGING_ENABLED 改成 true 即可。
                const closed = option === 'plain' && !PLAIN_PACKAGING_ENABLED
                return <button type="button" key={option} className={`jd-mini-option${editingEntry.packaging === option ? ' is-selected' : ''}${closed ? ' is-disabled' : ''}`} aria-pressed={editingEntry.packaging === option} aria-disabled={closed || undefined} disabled={closed} title={closed ? '普通包装暂不提供' : undefined} onClick={() => update(editingEntry.id, 'packaging', option)}>{packagingLabel(option)}<small>{closed ? '暂不提供' : option === 'gift' ? `${formatCents(giftPrice)} 元/盒` : '不另收费'}</small></button>
              })}
            </span></label>
          </div>
          {(() => { const current = totals.shipments[editingIndex]; return current && current.packaging === 'gift' && current.boxes > 0 ? <p className="jd-helper">礼盒费 {formatCents(giftPrice)} 元/盒 × {current.boxes} 盒</p> : null })()}
        </div>
        <div className="jd-address-modal-foot"><button type="button" className="jd-button" onClick={() => setEditingId(null)}>完成</button></div>
      </div>
    </div>}
  </>
}

function PurchaseSummary({ totals }) {
  const aggregated = new Map()
  // 预设套装按套装名整条显示；自定义套装才逐规格列。
  const presets = new Map()
  for (const shipment of totals.shipments) {
    if (shipment.mode === 'template' && shipment.templateName) {
      const row = presets.get(shipment.templateName) ?? { count: 0, crabCents: 0 }
      row.count += 1
      row.crabCents += shipment.crabCents ?? 0
      presets.set(shipment.templateName, row)
      continue
    }
    for (const item of shipment.items) {
      const entry = aggregated.get(item.specId) ?? { ...item, qty: 0 }
      entry.qty += item.qty * (shipment.copies ?? 1)
      aggregated.set(item.specId, entry)
    }
  }
  const items = [...aggregated.values()]
  const giftBoxes = totals.shipments.filter(shipment => shipment.packaging === 'gift').reduce((sum, shipment) => sum + shipment.boxes, 0)
  const plainCount = totals.shipments.filter(shipment => shipment.packaging === 'plain').length
  const giftPricePerBox = giftBoxes > 0 ? totals.shipments.find(shipment => shipment.packaging === 'gift').packagingCents / totals.shipments.filter(shipment => shipment.packaging === 'gift').reduce((sum, shipment) => sum + shipment.boxes, 0) : 0
  return <aside className="jd-summary">
    <h2>选购清单</h2>
    <div className="jd-summary-items">
      {[...presets].map(([name, row]) => <div key={`preset-${name}`}><span className="jd-inline-specs">预设套装 · {name} × {row.count} 套</span><strong>{formatYuan(row.crabCents)}</strong></div>)}
      {items.map(item => <div key={item.specId}><span className="jd-inline-specs"><SpecBadge gender={item.gender} weightLabel={item.weightLabel} compact /> × {item.qty}</span><strong>{formatYuan(item.qty * item.priceCents)}</strong></div>)}
      {plainCount > 0 && <div><span>普通包装 × {plainCount} 个地址</span><strong>免费</strong></div>}
      {giftBoxes > 0 && <div><span>礼盒（{formatCents(giftPricePerBox)} 元/盒 × {giftBoxes} 盒）</span><strong>{formatYuan(totals.packagingCents)}</strong></div>}
    </div>
    <div className="jd-summary-count"><strong>本单公蟹 {totals.maleCount} 只 + 母蟹 {totals.femaleCount} 只，共计 {totals.totalCount} 只</strong></div>
    <div className="jd-summary-total"><span>商品及包装合计</span><strong><small>¥</small> {formatCents(totals.totalCents)}</strong></div>
    <p className="jd-helper">运费另计，发货后更新。</p>
  </aside>
}

function LoginRequired({ message, onLogin }) {
  return <section className="jd-orders-page"><div className="jd-empty"><span className="jd-empty-bag"><AssetIcon name="bag" size={38} /></span><h2>登录后查看</h2><button className="jd-button" onClick={onLogin}>去登录<Arrow /></button></div></section>
}

// 购物车条目摘要：配置清单（只管搭配，不含份数）+ 包装 + 地址数/总只数。
// 份数由地址数量决定 —— 一条地址就是一套。
function draftSummary(draft, config) {
  const restored = readDraftPayload(draft.payload)
  const addresses = restored.addresses
  const filled = addresses.filter(entry => entry.name?.trim() || entry.phone?.trim() || entry.address?.trim())
  const fallbackId = restored.configs[0]?.id ?? null
  const rows = restored.configs.map(entry => {
    const items = config ? selectionItems(config, entry) : []
    return {
      id: entry.id,
      label: configLabel(config, entry),
      count: items.reduce((sum, item) => sum + item.qty, 0),
      detail: items.map(item => `${item.gender === 'male' ? '公' : '母'}${item.weightLabel} × ${item.qty}`).join(' ＋ ') || '尚未选择规格',
      sets: addresses.filter(address => (address.configId ?? fallbackId) === entry.id).length,
    }
  })
  return {
    rows,
    packaging: restored.packaging,
    addressCount: filled.length,
    totalCount: rows.reduce((sum, row) => sum + row.count * row.sets, 0),
  }
}

function CartScreen({ config, loggedIn, drafts, error, onNeedLogin, onReauth, onContinue, onDelete, navigate }) {
  if (!loggedIn) return <LoginRequired message="套装保存在服务端，登录下单码后即可查看。" onLogin={onNeedLogin} />
  return <section className="jd-orders-page">
    <div className="jd-form-heading"><h1>我的套装</h1></div>
    {error && <div role="alert" className="jd-form-error"><span>{error.message ?? error}</span>{isAuthError(error) && <button type="button" className="jd-button-plain" onClick={onReauth}>重新登录</button>}</div>}
    {drafts === null ? <p className="jd-helper">正在加载套装…</p> : drafts.length ? <div className="jd-order-list">{drafts.map(draft => <article className="jd-order" key={draft.id}>
      <div className="jd-order-top"><span>套装 {draft.id}</span><span className="jd-order-status">更新于 {formatTime(draft.updatedAt)}</span></div>
      {(() => {
        const summary = draftSummary(draft, config)
        return <>
          <h2>{summary.rows.length} 种配置 · 共 {summary.totalCount} 只</h2>
          <ul className="jd-draft-configs">
            {summary.rows.map(row => <li key={row.id}>
              <b>{row.label}</b>
              <span>{row.detail}（每套 {row.count} 只）</span>
              <em>{row.sets} 套</em>
            </li>)}
          </ul>
          <p className="jd-draft-detail">包装：{packagingLabel(summary.packaging)} · 去下单页填收货地址，一个地址就是一套</p>
        </>
      })()}
      <div className="jd-draft-actions"><button type="button" className="jd-order-reorder" onClick={() => onContinue(draft)}>继续下单 <Arrow /></button><button type="button" className="jd-order-reorder jd-draft-delete" onClick={() => onDelete(draft)}>删除套装</button></div>
    </article>)}</div> : <div className="jd-empty"><span className="jd-empty-bag"><AssetIcon name="bag" size={38} /></span><h2>还没有套装</h2><button className="jd-button" onClick={() => navigate('select')}>去挑选鲜蟹<Arrow /></button></div>}
  </section>
}

function ShipmentDetail({ shipment }) {
  return <div className="jd-shipment">
    <div className="jd-shipment-head"><strong>{String(shipment.seq).padStart(2, '0')} · {shipment.recipient}</strong><span>{shipmentStatusLabel(shipment.status)}</span></div>
    <p>{shipment.phone} · {shipment.address}</p>
    <p>{packagingLabel(shipment.packaging)}{shipment.copies ? ` × ${shipment.copies} 份` : ''} · 共 {shipment.boxes} 盒</p>
    <div className="jd-amount-lines">
      {shipment.items.map(item => <div key={item.specId}><span className="jd-inline-specs"><SpecBadge gender={item.gender} weightLabel={item.weightLabel} compact /> × {item.qty}{shipment.copies ? `（每份）` : ''}</span><b>{formatYuan(item.qty * item.priceCents)}</b></div>)}
      <div><span>蟹款</span><b>{formatYuan(shipment.amount.crabCents)}</b></div>
      <div><span>包装费</span><b>{formatYuan(shipment.amount.packagingCents)}</b></div>
      <div><span>运费</span><b>{shipment.amount.freightCents == null ? '待确认' : formatYuan(shipment.amount.freightCents)}</b></div>
      <div className="is-total"><span>小计{shipment.amount.freightCents == null ? '（不含运费）' : ''}</span><b>{formatYuan(shipment.amount.totalCents)}</b></div>
    </div>
  </div>
}

function OrdersScreen({ loggedIn, onNeedLogin, onReauth, onReorder, actionError, navigate, refreshKey }) {
  const [orders, setOrders] = useState(null)
  const [error, setError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [details, setDetails] = useState({})
  const [detailError, setDetailError] = useState('')

  useEffect(() => {
    if (!loggedIn) return undefined
    let cancelled = false
    setError(null)
    api.listOrders()
      .then(data => { if (!cancelled) setOrders(data.orders ?? []) })
      .catch(err => { if (!cancelled) setError(err) })
    return () => { cancelled = true }
  }, [loggedIn, refreshKey])

  if (!loggedIn) return <LoginRequired message="登录下单码后，即可查看你的全部订单。" onLogin={onNeedLogin} />

  async function toggle(order) {
    setDetailError('')
    if (expandedId === order.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(order.id)
    if (details[order.id]) return
    try {
      const data = await api.getOrder(order.id)
      setDetails(current => ({ ...current, [order.id]: data }))
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : '订单详情加载失败，请稍后重试。')
    }
  }

  if (error) {
    const authFailed = isAuthError(error)
    return <section className="jd-orders-page"><div className="jd-empty"><span className="jd-empty-bag"><AssetIcon name="bag" size={38} /></span><h2>{authFailed ? '下单码失效了。' : '订单暂时没有加载出来。'}</h2><p>{error.message}</p>{authFailed ? <button className="jd-button" onClick={onReauth}>重新登录<Arrow /></button> : <button className="jd-button" onClick={() => navigate('home')}>回到首页<Arrow /></button>}</div></section>
  }

  return <section className="jd-orders-page">
    <div className="jd-form-heading"><h1>我的订单</h1></div>
    {actionError && <p role="alert" className="jd-form-error">{actionError}</p>}
    {orders === null ? <p className="jd-helper">正在加载订单…</p> : orders.length ? <div className="jd-order-list">{orders.map(order => {
      const detail = details[order.id]
      const expanded = expandedId === order.id
      return <article className="jd-order" key={order.id}>
        <div className="jd-order-top"><span>{order.orderNo}</span><span className="jd-order-status">{orderStatusLabel(order.status)}{order.source === 'group' ? ' · 拼团' : ''}</span></div>
        <h2>{formatYuan(order.amount.crabCents + order.amount.packagingCents)} <small className="jd-order-amount-note">蟹款及包装</small></h2>
        <p>{formatTime(order.createdAt)} 下单{order.amount.freightCents == null ? ' · 运费待确认' : ` · 运费 ${formatYuan(order.amount.freightCents)}`}</p>
        <div className="jd-order-bottom"><span>应付合计{order.amount.freightCents == null ? '（运费待确认）' : ''}<small>点「查看明细」看每个地址的蟹款、包装费和运费</small></span><strong>{formatYuan(order.amount.totalCents)}</strong></div>
        {expanded && <div className="jd-order-detail">
          {detailError && !detail && <p role="alert" className="jd-form-error">{detailError}</p>}
          {!detail && !detailError && <p className="jd-helper">正在加载明细…</p>}
          {detail && <>{detail.shipments.map(shipment => <ShipmentDetail key={shipment.id} shipment={shipment} />)}<div className="jd-amount-lines jd-order-amount">
            <div><span>蟹款合计</span><b>{formatYuan(detail.order.amount.crabCents)}</b></div>
            <div><span>包装费合计</span><b>{formatYuan(detail.order.amount.packagingCents)}</b></div>
            <div><span>运费合计</span><b>{detail.order.amount.freightCents == null ? '待确认' : formatYuan(detail.order.amount.freightCents)}</b></div>
            <div className="is-total"><span>应付合计{detail.order.amount.freightCents == null ? '（运费待确认）' : ''}</span><b>{formatYuan(detail.order.amount.totalCents)}</b></div>
          </div></>}
        </div>}
        <div className="jd-draft-actions">
          <button type="button" className="jd-order-reorder" onClick={() => toggle(order)}>{expanded ? '收起明细' : '查看明细'}</button>
          <button type="button" className="jd-order-reorder" onClick={() => onReorder(order)}>同配置再下单 <Arrow /></button>
        </div>
      </article>
    })}</div> : <div className="jd-empty"><span className="jd-empty-bag"><AssetIcon name="bag" size={38} /></span><h2>暂无订单</h2><button className="jd-button" onClick={() => navigate('select')}>去挑选鲜蟹<Arrow /></button></div>}
  </section>
}

function GroupScreen({ loggedIn, user, onNeedLogin, onReauth, config, initialSelection, onMyGroups }) {
  const [selection, setSelection] = useState(() => initialSelection ?? defaultSelection(config))
  const [name, setName] = useState(user?.displayName ?? '')
  const items = selectionItems(config, selection)
  const count = items.reduce((sum, item) => sum + item.qty, 0)
  const crabCents = items.reduce((sum, item) => sum + item.qty * item.priceCents, 0)
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(null)
  const [copied, setCopied] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [error, setError] = useState(null)
  if (!loggedIn) return <LoginRequired message="登录下单码后即可发起拼团，生成分享链接。" onLogin={onNeedLogin} />

  async function submit(event) {
    event.preventDefault()
    if (creating || created) return
    if (!name.trim() || !count) { setError(new Error('请填写姓名，并至少选择 1 只螃蟹。')); return }
    const availabilityError = selectionAvailabilityError(config, selection)
    if (availabilityError) { setError(new Error(availabilityError)); return }
    setCreating(true)
    setError(null)
    try {
      const data = await api.createGroup(title.trim() || `${user?.displayName ?? '朋友'}的拼团`, { name: name.trim(), items: items.map(({ specId, qty }) => ({ specId, qty })) })
      setCreated(data)
      setCopied(false)
      if (data.member && data.editKey) {
        try { saveEditKey(data.token, data.member.id, data.editKey) } catch { setError(new Error('拼团已创建，但浏览器未能保存编辑凭据，请先保存：' + data.editKey)) }
      }
    } catch (err) {
      setError(err)
    } finally {
      setCreating(false)
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(createdUrl)
      setCopied(true)
    } catch {
      setCopied(false)
      setError(new Error('复制失败，请长按链接手动复制。'))
    }
  }

  if (error && isAuthError(error)) {
    return <section className="jd-orders-page"><div className="jd-empty"><span className="jd-empty-bag"><AssetIcon name="bag" size={38} /></span><h2>下单码失效了。</h2><p>{error.message}</p><button className="jd-button" onClick={onReauth}>重新登录<Arrow /></button></div></section>
  }

  let createdUrl = '', shareError = ''
  if (created) {
    try { createdUrl = buildShareUrl({ kind: 'group', token: created.token, baseUrl: config?.shareBaseUrl }) }
    catch (err) { shareError = err.message }
  }

  return <section className="jd-orders-page">
    <div className="jd-form-heading"><h1>{created ? title.trim() || `${user?.displayName ?? '朋友'}的拼团` : '发起拼团'}</h1><span>{created ? '已发布' : '满 10 只倍数，由团长提交'}</span></div>
    {!created && <form className="jd-group-form" onSubmit={submit}><fieldset className="jd-group-config" disabled={creating}>
      <Selection config={config} selection={selection} setSelection={setSelection} groupMode /><p className="jd-helper">我的合计 {count} 只 · 蟹款 {formatYuan(crabCents)}，包装和运费由全团分摊。</p><label>我的姓名<input value={name} onChange={event => setName(event.target.value)} maxLength={30} required aria-label="我的姓名" /></label>
      <label>拼团名称<input value={title} onChange={event => setTitle(event.target.value)} maxLength={50} placeholder={`${user?.displayName ?? '我'}的拼团`} aria-label="拼团名称" /></label>
      {error && <p role="alert" className="jd-form-error">{error.message}</p>}
      <button type="submit" className="jd-button" disabled={creating || !count || !config?.batch || config.batch.isAfterCutoff}>{creating ? '发布中…' : '发布团购'}<Arrow /></button></fieldset>
    </form>}
    {created && <div className="jd-group-result">
      {error && <p role="alert" className="jd-form-error">{error.message}</p>}
      <div className="jd-group-published-actions"><button type="button" className="jd-button-plain" onClick={() => setSharing(true)}><AssetIcon name="qr" size={18} />分享海报</button><a className="jd-button-plain" href={`/?group=${encodeURIComponent(created.token)}`}>查看团购<Arrow /></a><button type="button" className="jd-button-plain" onClick={onMyGroups}>我的团购</button></div>
      {shareError ? <p className="jd-form-error" role="alert">{shareError}</p> : <div className="jd-group-link"><code>{createdUrl}</code><button type="button" className="jd-button-plain" onClick={copyLink}>{copied ? '已复制' : '复制链接'}</button></div>}
    </div>}
    {sharing && created && <PosterShare kind="group" token={created.token} title={title.trim() || `${user?.displayName ?? '朋友'}的拼团`} baseUrl={config?.shareBaseUrl} onClose={() => setSharing(false)} />}
  </section>
}

// 草稿/回填的选购配置按当前配置消毒：失效的规格和模板自动丢弃。
function sanitizeSelection(config, raw) {
  if (!config) return null
  if (raw?.mode === 'template' && findTemplate(config, raw.templateId)) {
    return { mode: 'template', templateId: raw.templateId, items: {} }
  }
  const items = {}
  for (const spec of config.specs ?? []) {
    const qty = Math.min(99, Math.max(0, Number(raw?.items?.[spec.id]) || 0))
    if (qty > 0) items[spec.id] = qty
  }
  return { mode: 'custom', templateId: null, items }
}

function sanitizeAddresses(rawAddresses) {
  if (!Array.isArray(rawAddresses) || !rawAddresses.length) return emptyCartAddresses()
  return rawAddresses.map(entry => ({
    id: entry.id ?? crypto.randomUUID(),
    name: entry.name ?? '',
    phone: entry.phone ?? '',
    address: entry.address ?? '',
    configId: entry.configId ?? null,
    // 空串 = 跟随购物车的整车包装；填了就是这条地址单独覆盖（想混装就复制一条改包装）。
    packaging: entry.packaging === 'gift' || entry.packaging === 'plain' ? entry.packaging : '',
  }))
}

function findRepurchaseTemplate(config, shipment) {
  if (!shipment || !Number.isInteger(shipment.copies) || shipment.copies <= 0) return null
  const expected = new Map((shipment.items ?? []).map(item => [item.specId, item.qty]))
  return (config?.templates ?? []).find(template => {
    if (template.packaging !== shipment.packaging) return false
    const items = template.items ?? []
    if (items.length !== expected.size) return false
    return items.every(item => expected.get(item.specId) === item.quantity)
  }) ?? null
}

function Shop({ onLogin, onLogout, onAdmin, initialUser, initialScreen }) {
  const [screen, setScreen] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get('screen')
    return initialScreen ?? (['login', 'groups'].includes(requested) ? requested : 'home')
  })
  const [config, setConfig] = useState(null)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [configError, setConfigError] = useState('')
  const [selection, setSelection] = useState(null)
  const [addresses, setAddresses] = useState(() => emptyCartAddresses())
  // 购物车的配置清单：同一份搭配只存一条；份数由地址数量决定（一条地址 = 一套）。
  const [configs, setConfigs] = useState([])
  // 当前正在编辑的是清单里的哪一条（从购物车「继续下单」进来时指向那一条）。
  // 没有它，改数量就没法「就地更新这一条」，清单也不会再跟随输入。
  const [activeConfigId, setActiveConfigId] = useState(null)
  // 包装是整车统一的（礼盒 / 普通），默认礼盒。
  const [cartPackaging, setCartPackaging] = useState('gift')
  const [activeDraftId, setActiveDraftId] = useState(null)
  const [drafts, setDrafts] = useState(null)
  const [cartError, setCartError] = useState('')
  const [cartMessage, setCartMessage] = useState('')
  const [cartSaving, setCartSaving] = useState(false)
  const [user, setUser] = useState(initialUser ?? null)
  const [orderCode, setOrderCode] = useState(() => readOrderCode())
  const [loginNext, setLoginNext] = useState(null)
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [belowTenVisible, setBelowTenVisible] = useState(false)
  const [groupSelection, setGroupSelection] = useState(null)
  const [groupRevision, setGroupRevision] = useState(0)
  const [lastOrder, setLastOrder] = useState(null)
  const [checkoutNotice, setCheckoutNotice] = useState('')
  // 满减优惠码：couponInput = 独立券码输入框里的原文；appliedCoupon = 已点「使用」且校验通过的活动码。
  // 一个活动码所有用户共用，门槛/面额/剩余张数由后端 config/current 下发；
  // 券码绝不从订单备注里读（备注是自由文本，随手写一句带活动码的话就会误触发）。
  const [couponInput, setCouponInput] = useState('')
  const [appliedCoupon, setAppliedCoupon] = useState(null)
  const [couponMessage, setCouponMessage] = useState('')
  const [hasNavigated, setHasNavigated] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [parsedAddresses, setParsedAddresses] = useState([])
  const [noticeVisible, setNoticeVisible] = useState(() => shouldShowNotice())
  // 服务端公告：独立于内置「购买须知」，只在拿到内容且今天没看过（或内容变过）时展示。
  const [announcement, setAnnouncement] = useState('')
  const [announcementChecked, setAnnouncementChecked] = useState(false)
  const [announcementVisible, setAnnouncementVisible] = useState(false)
  const [shopPosterVisible, setShopPosterVisible] = useState(false)
  const [ordersRefreshKey, setOrdersRefreshKey] = useState(0)
  const [orderActionError, setOrderActionError] = useState('')
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuRef = useRef(null)
  const idempotencyRef = useRef({ key: null, payload: '' })
  const cartSavingRef = useRef(false)
  const mainRef = useRef(null)

  // 购物车配置清单（旧草稿降级为一条）；一条地址 = 一套，所以这里不再乘份数。
  const cartEntries = draftEntries(config, selection, configs, activeConfigId)
  const totals = calculatePurchase(config, cartEntries, addresses, cartPackaging)
  // 满减券预览：活动状态来自后端 config/current，门槛按蟹款（totals.crabCents）判定，
  // 与后端 createOrder 同口径；error 非空 = 现在用不了。
  const couponActivity = config?.coupon ?? null
  const coupon = couponPreview(couponActivity, totals.crabCents, appliedCoupon ?? '')
  const couponHint = couponActivityHint(couponActivity)
  // 实付 = 蟹款 + 包装费 - 券减免（后端 total_cents 也是这个口径，运费另计）。
  const payableCents = Math.max(0, totals.totalCents - coupon.discountCents)
  const isCheckout = screen === 'select' || screen === 'address'
  // 登录态以服务端身份（会话 cookie 恢复出来的 user）为准；本地旧下单码只是迁移期的兜底。
  const loggedIn = Boolean(user) || Boolean(orderCode)
  const noBatch = configLoaded && !config?.batch
  const cutoffPassed = config?.batch?.isAfterCutoff === true
  const cutoffText = formatBatchSchedule(config?.batch?.cutoffTime)

  const loadConfig = useCallback(async () => {
    try {
      const data = await api.getCurrentConfig()
      setConfig(data)
      setConfigError('')
    } catch (err) {
      setConfigError(err instanceof ApiError ? err.message : '商品配置加载失败，请稍后重试。')
    } finally {
      setConfigLoaded(true)
    }
  }, [])

  useEffect(() => {
    loadConfig()
    const timer = window.setInterval(loadConfig, 60000)
    return () => window.clearInterval(timer)
  }, [loadConfig])

  useEffect(() => {
    const cutoff = new Date(config?.batch?.cutoffTime).getTime()
    const remaining = cutoff - Date.now()
    const timer = Number.isFinite(remaining) && remaining > 0
      ? window.setTimeout(loadConfig, Math.min(remaining + 100, 2147483647)) : null
    const onVisible = () => { if (document.visibilityState === 'visible') loadConfig() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { if (timer) window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [config?.batch?.cutoffTime, loadConfig])

  useEffect(() => {
    if (config && !selection) setSelection(defaultSelection(config))
  }, [config, selection])

  // 账户菜单：点外部或 Esc 收起。
  useEffect(() => {
    if (!accountMenuOpen) return undefined
    const onDown = (event) => { if (!accountMenuRef.current?.contains(event.target)) setAccountMenuOpen(false) }
    const onKey = (event) => { if (event.key === 'Escape') setAccountMenuOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [accountMenuOpen])

  // 公告：接口可能 404（尚未发布）、超时或断网 —— 一律静默当没有公告，绝不影响页面渲染。
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), ANNOUNCEMENT_TIMEOUT_MS)
    fetch(`${API_BASE_URL}/config/notice`, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal: controller.signal })
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        const content = typeof data?.notice?.content === 'string' ? data.notice.content.trim() : ''
        if (content) setAnnouncement(content)
      })
      .catch(() => { /* 没有公告，或接口还没上线：静默跳过 */ })
      .finally(() => { window.clearTimeout(timer); setAnnouncementChecked(true) })
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [])

  // 公告展示：同一内容当天只出现一次；10 秒后自动消失，X 也能手动关。
  // ⚠️ 这里必须先用 ref 挡住「本次已处理」，再记账。
  // 原实现把 markAnnouncementSeen 直接写在这个 effect 里，而本 effect 依赖
  // [announcementChecked, announcement]、会随两次 setState 重跑：
  // 重跑时 shouldShowAnnouncement() 已经因为上一轮记过账返回 false，
  // 于是「显示」被自己取消掉 —— 线上表现就是「已看过记账了、却一次都没显示」，公告等于废掉。
  const announcementHandledRef = useRef('')
  useEffect(() => {
    if (!announcementChecked || !announcement) return undefined
    // ⚠️ 登录页不展示公告（渲染条件是 screen !== 'login'），所以这里也必须跳过，
    // 否则「记账了但看不到」：用户首次打开通常落在登录页，记账后登录进去，
    // 公告就再也不会出现了。记账条件必须与渲染条件严格一致。
    if (screen === 'login') return undefined
    if (announcementHandledRef.current === announcement) return undefined
    if (!shouldShowAnnouncement(announcement)) return undefined
    announcementHandledRef.current = announcement
    setAnnouncementVisible(true)
    markAnnouncementSeen(announcement)
    const timer = window.setTimeout(() => setAnnouncementVisible(false), ANNOUNCEMENT_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [announcementChecked, announcement, screen])

  // 购买须知：当天首次展示即记录，12 秒后自动消除；手动关闭也一样不再出现。
  // 有服务端公告时让位给公告（同屏不叠两条横幅）；公告为空或接口未发布时照旧展示。
  const builtinNoticeVisible = noticeVisible && announcementChecked && !announcement
  useEffect(() => {
    if (!builtinNoticeVisible) return undefined
    markNoticeSeen()
    const timer = window.setTimeout(() => setNoticeVisible(false), NOTICE_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [builtinNoticeVisible])

  const refreshDrafts = useCallback(async () => {
    // ⚠️ 不要再用 readOrderCode() 当登录判据：HttpOnly 会话上线后登录凭证只在 cookie 里，
    // localStorage 里的旧码恒为空 —— 这个守卫会让购物车永远停在「正在加载套装…」且一个请求都不发
    // （2026-09-20 实测：张三123 登录后点购物车，页面卡在加载态、window.__api 为空）。
    // 该不该加载由调用点的 loggedIn 决定；真未登录时接口返回 401，交给下面的错误分支。
    try {
      setDrafts(await listDrafts())
      setCartError('')
    } catch (err) {
      setCartError(err instanceof ApiError ? err : new Error('套装加载失败，请稍后重试。'))
    }
  }, [])

  useEffect(() => {
    if (screen === 'cart' && loggedIn) refreshDrafts()
  }, [screen, loggedIn, refreshDrafts])

  useEffect(() => {
    if (!hasNavigated) return
    mainRef.current?.focus({ preventScroll: true })
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [screen, hasNavigated])

  function navigate(next) {
    setSubmitError('')
    setCartMessage('')
    setCheckoutNotice('')
    setAccountMenuOpen(false)
    setHasNavigated(true)
    setScreen(next)
  }

  function beginGroup(shipment = null) {
    const items = shipment?.items ?? selectionItems(config, selection)
    const availabilityError = shipment ? itemsAvailabilityError(config?.specs, items) : selectionAvailabilityError(config, selection)
    if (availabilityError) {
      setBelowTenVisible(false)
      setSubmitError(availabilityError)
      return
    }
    setGroupRevision(value => value + 1)
    const multiplier = shipment?.copies ?? 1
    setGroupSelection({ mode: 'custom', templateId: null, items: Object.fromEntries(items.map(item => [item.specId, item.qty * multiplier])) })
    setBelowTenVisible(false)
    navigate('group')
  }

  function needsLogin(next) {
    if (loggedIn) return false
    setLoginNext(next)
    navigate('login')
    return true
  }

  function handleLogin(loggedInUser) {
    onLogin?.(loggedInUser)
    if (loggedInUser.role === 'admin' || loggedInUser.role === 'superadmin') return
    setUser(loggedInUser)
    setOrderCode(readOrderCode())
    refreshDrafts()
  }

  function closeLogin() {
    const next = loginNext
    setLoginNext(null)
    navigate(next ?? 'home')
  }

  function handleReauth() {
    clearOrderCode()
    setOrderCode('')
    setUser(null)
    setDrafts(null)
    navigate('login')
  }

  async function handleLogout() {
    if (onLogout) {
      await onLogout()
      return
    }
    // 必须同时吊销服务端会话：只清本地的话 HttpOnly cookie 还在，
    // 刷新页面就会又登录回来（验收时实测踩到）。
    try { await api.logout() } catch { /* 会话可能本来就失效了，本地照样清 */ }
    clearOrderCode()
    setOrderCode('')
    setUser(null)
    setDrafts(null)
    setAccountMenuOpen(false)
    navigate('home')
  }

  function selectProduct(spec) {
    setSelection({ mode: 'custom', templateId: null, items: { [spec.id]: 5 } })
    navigate('select')
  }

  function selectTemplate(template) {
    if (selectionAvailabilityError(config, { mode: 'template', templateId: template.id })) {
      navigate('select')
      return
    }
    setSelection({ mode: 'template', templateId: template.id, items: {} })
    // 预设套装 = 搭配已经定好，选完直接进「填收货信息」；截单/无批次时留在选蟹页说明情况。
    navigate(cutoffPassed || noBatch ? 'select' : 'address')
  }

  function importParsedAddresses(entries) {
    // 地址是核心，配置不是：批量粘贴只负责收货信息。
    // 行尾的「4公4母（2份）」在解析阶段已经剔除（免得污染地址文本），这里
    // 也不再用它改写选蟹配置和份数——识别偏差会直接下错单，风险大于便利。
    // 要买什么规格、几份，统一在选蟹页选。
    setAddresses(entries.map((entry, index) => ({
      id: `bulk-${index}-${Date.now()}`,
      name: entry.name,
      phone: entry.phone,
      address: entry.address,
      // 批量导入的地址默认挂第一条配置；想换在卡片弹窗里改。
      configId: cartEntries[0]?.id ?? null,
      // 空串 = 跟随购物车的整车包装。
      packaging: '',
      parseError: entry.error || '',
    })))
    setBulkText('')
    setParsedAddresses([])
  }

  async function saveToCart() {
    if (needsLogin(screen === 'select' ? 'select' : 'address')) return
    if (cartSavingRef.current) return
    // 同一份搭配只存一条。份数由地址数量决定（一条地址 = 一套），
    // 所以重复添加同一配置没有意义，只提示、不入库。
    // 注意：只跟「已加进购物车的 configs」比，不能拿 cartEntries 比 ——
    // 后者含当前正在编辑的 selection 兜底条，会变成自己跟自己比，永远判重。
    const candidate = selection ?? defaultSelection(config)
    // 正在编辑清单里已存在的那条时，判重要排除它自己，否则「原样保存」会被自己挡住。
    const editingId = activeConfigId && configs.some(entry => entry.id === activeConfigId) ? activeConfigId : null
    const others = editingId ? configs.filter(entry => entry.id !== editingId) : configs
    if (findDuplicateConfig(config, others, candidate)) {
      setCartMessage('这个搭配已经在套装里了。加一个收货地址就是多一套。')
      return
    }
    cartSavingRef.current = true
    setCartSaving(true)
    setCartMessage('')
    try {
      // 编辑已有那条就地更新；否则追加为新配置，并把它设为当前编辑对象
      const newId = `cfg-${Date.now()}`
      const nextConfigs = editingId
        ? configs.map(entry => (entry.id === editingId ? { ...entry, ...candidate } : entry))
        : [...configs, { id: newId, label: '', ...candidate }]
      setConfigs(nextConfigs)
      setActiveConfigId(editingId ?? newId)
      // 刷新后 activeDraftId 会丢。这时先复用已有草稿：否则每刷一次页面再「加入套装」，
      // 就会多出一条内容完全相同的草稿（实测踩过）。「我的套装」本来就只有一份清单，
      // 有草稿就更新、没有才新建。
      let draftId = activeDraftId
      if (draftId == null) {
        const existing = await listDrafts()
        draftId = existing.length ? existing[0].id : null
      }
      if (draftId != null) {
        await updateDraft(draftId, nextConfigs, cartPackaging, addresses)
        setActiveDraftId(draftId)
      } else {
        const draft = await createDraft(nextConfigs, cartPackaging, addresses)
        setActiveDraftId(draft?.id ?? null)
      }
      setCartMessage('已加入套装')
      refreshDrafts()
    } catch (err) {
      if (isAuthError(err)) {
        setLoginNext(screen === 'select' ? 'select' : 'address')
        handleReauth()
        return
      }
      setCartMessage(err instanceof ApiError ? err.message : '保存失败，请稍后重试。')
    } finally {
      cartSavingRef.current = false
      setCartSaving(false)
    }
  }

  function continueDraft(draft) {
    const restored = readDraftPayload(draft.payload)
    setConfigs(restored.configs)
    setCartPackaging(restored.packaging)
    const restoredAddresses = sanitizeAddresses(restored.addresses)
    setAddresses(restoredAddresses.length ? restoredAddresses : emptyCartAddresses())
    const first = restored.configs[0]
    setSelection(first ? { mode: first.mode, templateId: first.templateId, items: first.items } : null)
    setActiveConfigId(first?.id ?? null)
    setActiveDraftId(draft.id)
    navigate(restoredAddresses.some(entry => entry.name?.trim() || entry.phone?.trim() || entry.address?.trim()) ? 'address' : 'select')
    setCheckoutNotice('已恢复套装')
  }

  async function removeDraft(draft) {
    setCartError('')
    try {
      await deleteDraft(draft.id)
      setDrafts(current => current?.filter(entry => entry.id !== draft.id) ?? current)
      if (activeDraftId === draft.id) setActiveDraftId(null)
    } catch (err) {
      if (isAuthError(err)) {
        handleReauth()
        return
      }
      setCartError(err instanceof ApiError ? err : new Error('删除失败，请稍后重试。'))
    }
  }

  async function reorder(order) {
    setOrderActionError('')
    try {
      const data = await api.getRepurchaseConfig(order.id)
      const first = data.shipments?.[0]
      const template = findRepurchaseTemplate(config, first)
      if (template) {
        setSelection({ mode: 'template', templateId: template.id, items: {} })
      } else {
        const items = {}
        for (const item of first?.items ?? []) {
          if (config?.specs?.some(spec => spec.id === item.specId)) items[item.specId] = (items[item.specId] ?? 0) + item.qty
        }
        setSelection(Object.keys(items).length ? { mode: 'custom', templateId: null, items } : defaultSelection(config))
      }
      setAddresses((data.shipments ?? []).length
        ? data.shipments.map(shipment => ({ id: crypto.randomUUID(), name: '', phone: '', address: '', packaging: shipment.packaging === 'gift' ? 'gift' : 'plain', copies: Math.max(1, Number(shipment.copies) || 1) }))
        : emptyCartAddresses())
      setActiveDraftId(null)
      navigate('address')
      setCheckoutNotice('已按上次配置回填规格和包装；收货地址请重新粘贴或填写。')
    } catch (err) {
      if (isAuthError(err)) {
        handleReauth()
        return
      }
      setOrderActionError(err instanceof ApiError ? err.message : '复购配置加载失败，请稍后重试。')
    }
  }

  // 活动码来自**独立输入框 + 独立的「使用」动作**，绝不从备注里读
  // （备注是自由文本，随手写一句带活动码的话会被误触发）。
  // 点「使用」时就按后端下发的活动状态判一遍（码对不对 / 生效没 / 还剩几张 / 蟹款够不够），
  // 给明确反馈，不用等到提交才报错；最终仍以后端 createOrder 的结果为准。
  function applyCoupon() {
    const preview = couponPreview(couponActivity, totals.crabCents, couponInput)
    if (preview.error) {
      setAppliedCoupon(null)
      setCouponMessage(preview.error)
      return
    }
    if (!preview.code) {
      setAppliedCoupon(null)
      setCouponMessage('请输入满减优惠码。')
      return
    }
    setAppliedCoupon(preview.code)
    setCouponMessage(`已使用「${preview.code}」，立减 ${formatYuan(preview.discountCents)}`)
  }

  function clearCoupon() {
    setAppliedCoupon(null)
    setCouponMessage('')
  }

  function submitPreview(event) {
    event.preventDefault()
    if (screen !== 'address') return
    if (noBatch) {
      setSubmitError('当前暂无开放下单的批次。')
      return
    }
    if (cutoffPassed) {
      setSubmitError('本批次已过截单时间，请等待下一批次。')
      return
    }
    if (!totals.totalCount) {
      setSubmitError('请先选择蟹的规格和数量。')
      return
    }
    if (!addresses.length) {
      setSubmitError('请至少添加一个收货地址。')
      return
    }
    // 有问题的地址允许先导入暂存，但提交必须逐条改对，避免脏数据进订单。
    const badIndex = addresses.findIndex(entry => entry.parseError
      || !PHONE_PATTERN.test((entry.phone || '').trim())
      || !entry.name.trim()
      || entry.address.trim().length < 5)
    if (badIndex >= 0) {
      const bad = addresses[badIndex]
      const reason = bad.parseError
        || (!PHONE_PATTERN.test((bad.phone || '').trim())
          ? '手机号应为 11 位有效号码'
          : '收货人或详细地址不完整（地址至少 5 个字）')
      setSubmitError(`第 ${badIndex + 1} 条地址有问题：${reason}。请返回修改后再提交。`)
      document.querySelector(`[data-address-index="${badIndex}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    if (needsLogin('address')) return
    submitOrder()
  }

  async function submitOrder({ confirmBelowTen = false } = {}) {
    if (submitting) return
    const usedEntries = addresses.map(address => cartEntries.find(entry => entry.id === address.configId) ?? cartEntries[0])
    const availabilityError = usedEntries.map(entry => selectionAvailabilityError(config, entry)).find(Boolean)
    if (availabilityError) { setSubmitError(availabilityError); return }
    const shipments = buildShipmentsPayload(config, cartEntries, addresses, cartPackaging)
    const serialized = JSON.stringify(shipments)
    if (idempotencyRef.current.payload !== serialized) {
      idempotencyRef.current = { key: crypto.randomUUID(), payload: serialized }
    }
    setSubmitting(true)
    setSubmitError('')
    try {
      const payload = { idempotencyKey: idempotencyRef.current.key, shipments }
      if (confirmBelowTen) payload.confirmBelowTen = true
      // 券由用户点「使用」并校验通过后才带上；后端会再算一次并做限次判定。
      if (coupon.code) payload.couponCode = coupon.code
      if (activeDraftId != null) payload.draftId = activeDraftId
      const data = await api.createOrder(payload)
      idempotencyRef.current = { key: null, payload: '' }
      setLastOrder(data)
      setActiveDraftId(null)
      setAddresses(emptyCartAddresses())
      setBelowTenVisible(false)
      setCouponInput('')
      setAppliedCoupon(null)
      setCouponMessage('')
      refreshDrafts()
      setOrdersRefreshKey(key => key + 1)
      navigate('success')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BELOW_TEN_NEEDS_CONFIRM') {
        setBelowTenVisible(true)
      } else if (err instanceof ApiError && err.code === 'CUTOFF_PASSED') {
        setSubmitError('已切换新批次，请核对后再次提交。')
        loadConfig()
      } else if (err instanceof ApiError && ['SPEC_NOT_ORDERABLE', 'SPEC_INVALID'].includes(err.code)) {
        setSubmitError(err.message)
        loadConfig()
      } else if (err instanceof ApiError && typeof err.code === 'string' && err.code.startsWith('COUPON_')) {
        // 券被后端拦下（活动未生效 / 码不对 / 已用完 / 未达门槛 / 拼团不参与）：
        // 在券那一行写明原因，并清掉已应用的券 —— 用户再点一次提交就是「不用券下单」。
        setCouponInput('')
        setAppliedCoupon(null)
        setCouponMessage(err.message)
        setSubmitError(err.message)
      } else if (isAuthError(err)) {
        handleReauth()
      } else {
        setSubmitError(err instanceof ApiError ? err.message : '提交失败，请稍后重试。')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const successCrabCount = lastOrder ? lastOrder.shipments.reduce((sum, shipment) => sum + shipment.items.reduce((inner, item) => inner + item.qty, 0) * (shipment.copies ?? 1), 0) : 0

  return <div className={`jd-storefront${screen === 'home' ? ' jd-storefront-home' : ''}`}><a className="jd-skip-link" href="#jd-main">跳到主要内容</a><header className="jd-header"><Brand onClick={() => navigate('home')} /><nav aria-label="购物导航"><button className={screen === 'home' ? 'is-active' : ''} onClick={() => navigate('home')}>当季鲜蟹</button><button className={isCheckout ? 'is-active' : ''} onClick={() => navigate('select')}>挑选好蟹</button></nav><div className="jd-header-actions jd-header-account">{onAdmin && <button type="button" className="jd-my-orders jd-admin-entry" aria-label="管理后台" title="管理后台" onClick={onAdmin}><AssetIcon name="sliders" size={18} /><span>管理后台</span></button>}<button className="jd-my-orders jd-cart-button" aria-label="我的套装" onClick={() => navigate('cart')}><BagIcon /><span>我的套装</span>{loggedIn && drafts?.length > 0 && <b>{drafts.length}</b>}</button><button className="jd-my-orders" aria-label="我的订单" onClick={() => navigate('orders')}><AssetIcon name="box" size={18} /><span>我的订单</span></button><button type="button" className="jd-my-orders jd-group-entry" aria-label="我的团购" onClick={() => navigate('groups')}><AssetIcon name="users" size={18} /><span>我的团购</span></button><div className="jd-account-menu" ref={accountMenuRef}><button type="button" className="jd-login-entry" aria-current={screen === 'login' ? 'page' : undefined} aria-haspopup={loggedIn ? 'menu' : undefined} aria-expanded={loggedIn ? accountMenuOpen : undefined} onClick={() => (loggedIn ? setAccountMenuOpen(v => !v) : navigate('login'))}>{user?.displayName ?? (loggedIn ? '已登录' : '登录')}</button>{loggedIn && accountMenuOpen && <div className="jd-account-dropdown" role="menu"><span className="jd-account-name">{user?.displayName ?? '已登录'}</span><button type="button" role="menuitem" onClick={handleLogout}>退出登录</button></div>}</div></div></header>{announcementVisible && screen !== 'login' && <div className="jd-notice jd-notice-announcement" role="status" aria-live="polite"><span>{announcement}</span><button aria-label="关闭公告" onClick={() => setAnnouncementVisible(false)}>×</button></div>}{builtinNoticeVisible && screen !== 'login' && <div className="jd-notice" role="status" aria-live="polite"><span>购买前请先了解：我们会认真打包，但活鲜运输途中仍可能出现极少量损耗。按 10 只计算，我们最多只能承受 1 只死蟹的损耗，出现 2 只就会亏本；实际运输货损率很低。若您不能接受这类小概率风险，请先不要下单，感谢理解。</span><button aria-label="关闭购买须知" onClick={() => setNoticeVisible(false)}>×</button></div>}<main id="jd-main" ref={mainRef} tabIndex={-1}>
    {screen === 'login' && <LoginPage onBack={closeLogin} onLogin={handleLogin} />}
    {configError && screen !== 'login' && screen !== 'home' && <div className="jd-notice" role="alert"><span>{configError}</span><button onClick={loadConfig}>重试</button></div>}
    {screen === 'home' && <Home config={config} navigate={navigate} selectProduct={selectProduct} selectTemplate={selectTemplate} loading={!configLoaded} error={configError} onRetry={loadConfig} cutoffPassed={cutoffPassed} noBatch={noBatch} cutoffText={cutoffText} onShare={() => setShopPosterVisible(true)} />}
    {isCheckout && <div className="jd-checkout"><div className="jd-checkout-top"><button className="jd-link" onClick={() => navigate(screen === 'select' ? 'home' : 'select')}><Arrow back />{screen === 'select' ? '返回鲜蟹首页' : '返回修改鲜蟹'}</button><ol className="jd-steps" aria-label="选购进度"><li aria-current={screen === 'select' ? 'step' : undefined} className={screen === 'select' ? 'is-current' : 'is-done'}><span>1</span>选蟹与包装</li><li aria-current={screen === 'address' ? 'step' : undefined} className={screen === 'address' ? 'is-current' : ''}><span>2</span>填写收货信息</li></ol><span className={`jd-checkout-cutoff${cutoffPassed || noBatch ? ' is-passed' : ''}`}>{noBatch ? '当前暂无在售批次' : cutoffPassed ? '本批次已截单' : cutoffText}</span></div><form onSubmit={submitPreview} id="jd-checkout-form" noValidate><div className="jd-checkout-grid"><div>{screen === 'select' ? <Selection config={config} selection={selection} setSelection={setSelection} onPickTemplate={() => navigate(cutoffPassed || noBatch ? 'select' : 'address')} /> : <AddressForm config={config} selection={selection} entries={cartEntries} cartPackaging={cartPackaging} addresses={addresses} setAddresses={setAddresses} totals={totals} bulkText={bulkText} setBulkText={setBulkText} parsedAddresses={parsedAddresses} setParsedAddresses={setParsedAddresses} onImport={importParsedAddresses} />}</div><PurchaseSummary totals={totals} /></div>{screen === 'select' && selectionItems(config, selection).reduce((sum, item) => sum + item.qty, 0) > 0 && selectionItems(config, selection).reduce((sum, item) => sum + item.qty, 0) < BOX_CAPACITY && <p className="jd-helper" role="status">当前搭配不足 10 只，可以和朋友凑一盒。<button type="button" className="jd-button-plain" disabled={cutoffPassed || noBatch} onClick={() => beginGroup()}>按当前搭配发起拼团</button></p>}{checkoutNotice && <p className="jd-helper" role="status">{checkoutNotice}</p>}{cartMessage && <p className="jd-helper" role="status">{cartMessage}</p>}{submitError && <p role="alert" className="jd-form-error">{submitError}</p>}{screen === 'address' && <div className="jd-coupon"><label htmlFor="jd-coupon-input">满减优惠码</label><input id="jd-coupon-input" type="text" value={couponInput} autoComplete="off" placeholder="输入活动码" onChange={(event) => setCouponInput(event.target.value)} />{appliedCoupon ? <button type="button" className="jd-button-plain" onClick={clearCoupon}>取消用券</button> : <button type="button" className="jd-button-plain" onClick={applyCoupon}>使用</button>}<span className={`jd-coupon-msg${coupon.error ? ' is-error' : ''}`} role="status">{coupon.error || couponMessage || couponHint}</span></div>}<div className="jd-checkout-bar"><div aria-live="polite"><span>本单合计 公蟹 {totals.maleCount} 只 + 母蟹 {totals.femaleCount} 只，共计 {totals.totalCount} 只</span><strong>{formatYuan(payableCents)}</strong>{coupon.discountCents > 0 && <small className="jd-coupon-line">已用「{coupon.code}」立减 {formatYuan(coupon.discountCents)}</small>}<small>运费另计 · 全程冷链 + 冰块保鲜</small></div>{screen === 'select' ? <div key="continue-group" className="jd-checkout-bar-actions"><button type="button" className="jd-button-plain" disabled={!totals.totalCount || cartSaving || submitting} onClick={saveToCart}>{cartSaving ? '保存中…' : '加入套装'}</button><button type="button" className="jd-button" disabled={!totals.totalCount || cutoffPassed || noBatch} onClick={() => navigate('address')}>{cutoffPassed || noBatch ? '暂不可下单' : '继续填写地址'}<Arrow /></button></div> : <div key="submit-group" className="jd-checkout-bar-actions"><button type="button" className="jd-button-plain" disabled={!totals.totalCount || cartSaving || submitting} onClick={saveToCart}>{cartSaving ? '保存中…' : '加入套装'}</button><button type="submit" className="jd-button" aria-label="厚礼蟹，提交订单" disabled={cutoffPassed || noBatch || submitting}>{cutoffPassed || noBatch ? '暂不可下单' : submitting ? '提交中…' : '厚礼蟹'}<Arrow /></button></div>}</div></form></div>}
    {screen === 'cart' && <CartScreen config={config} loggedIn={loggedIn} drafts={drafts} error={cartError} onNeedLogin={() => needsLogin('cart')} onReauth={handleReauth} onContinue={continueDraft} onDelete={removeDraft} navigate={navigate} />}
    {screen === 'orders' && <OrdersScreen loggedIn={loggedIn} onNeedLogin={() => needsLogin('orders')} onReauth={handleReauth} onReorder={reorder} actionError={orderActionError} navigate={navigate} refreshKey={ordersRefreshKey} />}
    {screen === 'groups' && <MyGroups loggedIn={loggedIn} onNeedLogin={() => needsLogin('groups')} onReauth={handleReauth} onCreate={() => beginGroup()} baseUrl={config?.shareBaseUrl} />}
    {screen === 'group' && <GroupScreen key={groupRevision} config={config} initialSelection={groupSelection} loggedIn={loggedIn} user={user} onNeedLogin={() => needsLogin('group')} onReauth={handleReauth} onMyGroups={() => navigate('groups')} />}
    {screen === 'success' && <section className="jd-success"><span className="jd-success-icon"><AssetIcon name="check" size={32} /></span><h1>订单已提交。</h1>{lastOrder ? <><p>订单编号 {lastOrder.order.orderNo} · 共 {successCrabCount} 只鲜蟹，分送 {lastOrder.shipments.length} 个地址。</p><p>蟹款及包装合计 {formatYuan(lastOrder.order.amount.totalCents)}，运费待发货前确认后更新。</p>{lastOrder.order.amount.discountCents > 0 && <p>已用「{lastOrder.order.amount.couponCode}」优惠券，立减 {formatYuan(lastOrder.order.amount.discountCents)}。</p>}</> : <p>订单已提交，可在「我的订单」查看。</p>}<button className="jd-button" onClick={() => navigate('orders')}>查看订单<Arrow /></button><button className="jd-link" onClick={() => navigate('select')}>再下一单</button><button className="jd-link" onClick={() => navigate('home')}>再逛一逛</button></section>}
    {belowTenVisible && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="jd-below-ten-title"><h2 id="jd-below-ten-title">不足 {BOX_CAPACITY} 只，仍要提交吗？</h2><p>不足 {BOX_CAPACITY} 只要按 1 盒收包装费，运费也摊不下来。凑满一盒或拼团更划算。</p><div className="modal-actions">{totals.shipments.map((shipment, index) => shipment.totalCount > 0 && shipment.totalCount < BOX_CAPACITY && <button key={addresses[index].id} type="button" className="jd-button-plain" disabled={submitting} onClick={() => beginGroup(shipment)}>按地址 {index + 1} 的 {shipment.totalCount} 只搭配发起拼团</button>)}<button type="button" className="jd-button-plain" onClick={() => setBelowTenVisible(false)}>返回修改</button><button type="button" className="jd-button" disabled={submitting} onClick={() => submitOrder({ confirmBelowTen: true })}>{submitting ? '提交中…' : '仍然提交'}<Arrow /></button></div></div></div>}
    {shopPosterVisible && <PosterShare kind="shop" baseUrl={config?.shareBaseUrl} onClose={() => setShopPosterVisible(false)} />}
  </main><footer className="jd-footer"><span>中国·江都</span><span>把这一季的鲜，留给好好生活的人。</span></footer></div>
}

export default function Storefront(props) {
  return new URLSearchParams(window.location.search).get('assets') === '1' ? <ImageAtlasBoard /> : <Shop {...props} />
}
