/**
 * 归档说明：旧版用户端已停止挂载。
 * 当前用户端入口为 src/storefront/Storefront.jsx。
 * 本文件仅用于历史回溯，不参与构建。
 */

function OrderCountSummary({ qty, addressCount }) { const perAddress = qty * 2; const total = perAddress * addressCount; return <div className="order-count-summary"><span className="eyebrow">本单合计</span><strong>{qty} 只 4 两公蟹 + {qty} 只 3.5 两母蟹</strong><p>每个地址共 {perAddress} 只 · {addressCount} 个地址共计 {total} 只</p></div> }

function parseBulkAddresses(text) {
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const normalized = line.replace(/^\s*\d+\s*[、.)．]?\s*/, '')
    const quantityMatch = normalized.match(/[-—]\s*(\d+)\s*公\s*(\d+)\s*母/)
    const base = quantityMatch ? normalized.slice(0, quantityMatch.index).trim() : normalized
    const phoneMatch = base.match(/1\d{9,10}/)
    if (!phoneMatch) return { raw: line, name: '', phone: '', address: '', maleQty: '', femaleQty: '', error: '未识别到手机号' }
    const beforePhone = base.slice(0, phoneMatch.index)
    const address = base.slice(phoneMatch.index + phoneMatch[0].length).replace(/^[\s,，:：-]+/, '').trim()
    const name = beforePhone.replace(/[^\u4e00-\u9fa5]/g, '').slice(-4)
    return { raw: line, name, phone: phoneMatch[0], address, maleQty: quantityMatch?.[1] || '', femaleQty: quantityMatch?.[2] || '', error: name && address ? '' : '姓名或地址不完整' }
  })
}

function UserView({ onToast }) {
  const [screen, setScreen] = useState('home')
  const [qty, setQty] = useState(5)
  const [addressEntries, setAddressEntries] = useState([{ name: '', phone: '', address: '' }])
  const [bulkText, setBulkText] = useState('')
  const [parsedEntries, setParsedEntries] = useState([])

  const addAddress = () => setAddressEntries((entries) => [...entries, { name: '', phone: '', address: '' }])
  const removeAddress = (index) => setAddressEntries((entries) => entries.filter((_, entryIndex) => entryIndex !== index))
  const updateAddress = (index, field, value) => setAddressEntries((entries) => entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: value } : entry))

  if (screen === 'paste') return <div className="user-shell">
    <div className="user-top"><button className="back-button" onClick={() => setScreen('create')}>← 返回采购配置</button><span className="user-step">地址导入</span></div>
    <div className="user-content">
      <span className="eyebrow">批量粘贴收货信息</span>
      <h1>一大坨粘贴进来，<em>我们帮你拆。</em></h1>
      <p className="user-intro">每行一条，支持“姓名 手机号 地址 - 4公4母（1份）”这类格式。解析后请逐条确认。</p>
      <label className="bulk-input-label" htmlFor="bulk-address-input">收货信息<textarea id="bulk-address-input" value={bulkText} onChange={(event) => { setBulkText(event.target.value); setParsedEntries([]) }} placeholder="例如：郭佳丽 13588002588 杭州市余杭区…… -4公4母（1份）" /></label>
      <button className="button primary user-cta" onClick={() => setParsedEntries(parseBulkAddresses(bulkText))}>解析这批地址 <Icon name="arrow" size={17} /></button>
      {parsedEntries.length > 0 && <div className="parsed-preview"><div className="parsed-head"><div><span className="eyebrow">解析预览</span><strong>识别到 {parsedEntries.length} 条</strong></div><span>{parsedEntries.filter((entry) => entry.error).length ? '请先修正异常项' : '全部可导入'}</span></div>{parsedEntries.map((entry, index) => <div className={`parsed-row ${entry.error ? 'has-error' : ''}`} key={`${entry.raw}-${index}`}><span>{index + 1}</span><div><strong>{entry.name || '未识别姓名'} · {entry.phone || '未识别电话'}</strong><p>{entry.address || entry.error}</p></div><b>{entry.maleQty && entry.femaleQty ? `${entry.maleQty}公${entry.femaleQty}母` : '待确认'}</b></div>)}<button className="button primary user-cta" disabled={parsedEntries.some((entry) => entry.error)} onClick={() => { setAddressEntries(parsedEntries.map(({ name, phone, address }) => ({ name, phone, address }))); const first = parsedEntries.find((entry) => entry.maleQty && entry.femaleQty); if (first) setQty(Number(first.maleQty)); setScreen('create'); onToast(`已导入 ${parsedEntries.length} 个地址`) }}>确认导入 {parsedEntries.length} 个地址 <Icon name="check" size={17} /></button></div>}
    </div>
  </div>

  if (screen === 'address') return <div className="user-shell">
    <div className="user-top"><button className="back-button" onClick={() => setScreen('create')}>← 返回修改</button><span className="user-step">02 / 02</span></div>
    <div className="user-content">
      <span className="eyebrow">收货信息 · {addressEntries.length} 个地址</span>
      <h1>最后一步，<em>告诉我们寄到哪。</em></h1>
      <p className="user-intro">每个地址会生成独立发货单，规格和包装沿用上一页的选择。</p>
      <div className="address-form-list">
        {addressEntries.map((entry, index) => <div className="address-card" key={`address-${index}`}>
          <div className="address-card-head"><span className="eyebrow">地址 {index + 1}</span>{addressEntries.length > 1 && <button className="remove-address" onClick={() => removeAddress(index)}>删除</button>}</div>
          <label htmlFor={`recipient-${index}`}>收货人<input id={`recipient-${index}`} value={entry.name} onChange={(event) => updateAddress(index, 'name', event.target.value)} placeholder="请输入收货人" /></label>
          <label htmlFor={`phone-${index}`}>手机号<input id={`phone-${index}`} value={entry.phone} onChange={(event) => updateAddress(index, 'phone', event.target.value)} placeholder="请输入手机号" inputMode="tel" /></label>
          <label htmlFor={`address-${index}`}>收货地址<input id={`address-${index}`} value={entry.address} onChange={(event) => updateAddress(index, 'address', event.target.value)} placeholder="省 / 市 / 区 · 详细地址" /></label>
        </div>)}
        <button className="add-address-button" onClick={addAddress}><Icon name="plus" size={16} />添加其他地址</button>
      </div>
      <div className="estimate-row"><OrderCountSummary qty={qty} addressCount={addressEntries.length} /><div className="estimate"><span>预计金额</span><strong>¥ {qty * 90 * addressEntries.length}</strong><small>运费待发货前确认</small></div></div>
      <button className="button primary user-cta" onClick={() => { onToast(`已创建 ${addressEntries.length} 个发货单，价格快照已锁定`); setScreen('home') }}>厚礼蟹 <Icon name="check" size={17} /></button>
    </div>
  </div>

  if (screen === 'create') return <div className="user-shell">
    <div className="user-top"><button className="back-button" onClick={() => setScreen('home')}>← 返回</button><span className="user-step">01 / 02</span></div>
    <div className="user-content"><span className="eyebrow">2026 中秋 · 销售中</span><h1>今天想怎么吃？</h1><p className="user-intro">选好规格和数量，我们按每个地址分别装箱。价格会锁定在提交的这一刻。</p>
      <div className="choice-card"><div className="choice-head"><div><span className="eyebrow">快捷套餐</span><h2>4 两公 + 3.5 两母</h2></div><span className="price-tag">¥ 468 起</span></div><div className="choice-body"><div className="mini-spec"><span className="spec-badge coral">公</span><div><strong>4 两公蟹</strong><small>¥ 48 / 只</small></div><div className="stepper"><button onClick={() => setQty(Math.max(1, qty - 1))}>−</button><b>{qty}</b><button onClick={() => setQty(qty + 1)}>+</button></div></div><div className="mini-spec"><span className="spec-badge amber">母</span><div><strong>3.5 两母蟹</strong><small>¥ 42 / 只</small></div><div className="stepper"><button>−</button><b>{qty}</b><button>+</button></div></div></div></div>
      <div className="package-choice"><span className="eyebrow">包装方式</span><div className="package-options"><button className="package-option selected"><span><i />普通包装</span><b>¥ 0</b></button><button className="package-option"><span><i />豪华礼盒</span><b>¥ 48 / 10 只</b></button></div></div>
      <div className="address-summary"><div><div><span className="eyebrow">收货地址</span><strong>{addressEntries.length} 个地址 · 共 {qty * 2 * addressEntries.length} 只</strong></div><button className="text-action" onClick={() => setScreen('paste')}>批量粘贴 <Icon name="plus" size={16} /></button></div><p>推荐直接粘贴整批收货信息，系统会先解析，再由你确认。</p></div>
      <div className="estimate-row"><OrderCountSummary qty={qty} addressCount={addressEntries.length} /><div className="estimate"><span>预计金额</span><strong>¥ {qty * 90 * addressEntries.length + 48 * Math.max(addressEntries.length - 1, 0)}</strong><small>运费待发货前确认</small></div></div><button className="button primary user-cta" onClick={() => { onToast('已保存采购配置，下一步填写地址'); setScreen('address') }}>继续填写地址 <Icon name="arrow" size={17} /></button>
    </div>
  </div>

  return <div className="user-shell user-home"><div className="user-top"><div className="user-brand"><span className="brand-mark"><Icon name="crab" size={20} /></span><strong>蟹务台</strong></div><span className="user-name">张三 <span className="avatar tiny">张</span></span></div><div className="user-content home-content"><div className="user-hero"><span className="eyebrow">当前发售 · 260918-A</span><h1>一桌好蟹，<br /><em>从这里开始。</em></h1><p>新鲜捕捞，按地址分别发货。现在下单，预计周六起捞。</p><div className="user-cutoff-note"><Icon name="bell" size={15} /><span><strong>今日 17:00 自动截单</strong> · 17:00 前下单当天发走</span></div><button className="button primary user-cta" onClick={() => setScreen('create')}>我要下单 <Icon name="arrow" size={17} /></button></div><div className="my-order-card"><div><span className="eyebrow">我的订单</span><strong>260910-0008</strong><p>已完成 · 20 只 · ¥ 860</p></div><Icon name="chevron" /></div><div className="user-note"><Icon name="check" size={16} /><span>当前批次还在销售中，截单前可以修改订单。</span></div></div></div>
}
