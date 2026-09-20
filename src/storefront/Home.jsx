import { AssetIcon } from './ImageSlot'
import { formatYuan } from './api'
import { formatCutoffTime, selectionAvailabilityError } from './purchase'
import SpecBadge, { specAssetVersion } from '../shared/SpecBadge'

const visualAssetVersion = '20260920-tied-crab-v5'

// 首页只展示当前在售配置，价格与下单页来自同一个 API。
export default function Home({ config, navigate, selectProduct, selectTemplate, cutoffPassed, noBatch, cutoffText, loading, error, onRetry, onShare }) {
  const specs = config?.specs ?? []
  const template = config?.templates?.[0]
  const templateError = template ? selectionAvailabilityError(config, { mode: 'template', templateId: template.id }) : ''
  const unavailable = loading || Boolean(error) || cutoffPassed || noBatch
  const groups = [
    { gender: 'male', label: '公蟹' },
    { gender: 'female', label: '母蟹' },
  ].map(group => ({ ...group, specs: specs.filter(spec => spec.gender === group.gender) }))
  const cutoffTime = formatCutoffTime(config?.batch?.cutoffTime)
  const availability = loading ? '正在读取今日价格…' : error ? '今日价格暂未加载' : noBatch ? '当前暂无在售批次' : cutoffPassed ? '本批次已截单' : cutoffTime ? `今日 ${cutoffTime} 截单` : cutoffText

  return <section className="jd-home-price-list" aria-labelledby="jd-home-title">
    {/* Hero 用熟蟹建立食欲，完整蟹体、姜丝香醋和醋瓶都留在响应式安全区。 */}
    <div className="jd-home-hero">
      <img src={`/assets/jiangdu-v1/banner.webp?v=${visualAssetVersion}`} alt="完整清蒸大闸蟹配姜丝镇江香醋" fetchPriority="high" />
      <div className="jd-home-hero-copy">
        <h1 id="jd-home-title">当季鲜蟹</h1>
        <p className={`jd-home-hero-time${unavailable ? ' is-unavailable' : ''}`}><AssetIcon name="clock" size={15} />{availability}</p>
        <div className="jd-home-hero-actions">
          <button type="button" className="jd-button" disabled={unavailable || specs.length === 0} onClick={() => navigate('select')}>{noBatch ? '等待开售' : cutoffPassed ? '已截单' : '自定义套装下单'}<AssetIcon name="arrow-right" size={16} /></button>
          <button type="button" className="jd-button-plain" onClick={onShare}><AssetIcon name="qr" size={16} />分享店铺</button>
        </div>
      </div>
    </div>

    {/* 卖点条：把「冷链 + 冰块」「礼盒」「产地」讲在单价之前。 */}
    <ul className="jd-home-points">
      <li><AssetIcon name="leaf" size={17} /><b>江都蟹塘直发</b><span>当日捕捞，当日装箱</span></li>
      <li><AssetIcon name="truck" size={17} /><b>全程冷链 + 冰块</b><span>活鲜发货，冰袋护航</span></li>
      <li><AssetIcon name="box" size={17} /><b>礼盒 / 普通包装</b><span>满 10 只即可成盒</span></li>
    </ul>

    <header className="jd-home-heading">
      <div className="jd-home-title-row"><h2 id="jd-home-price-title">鲜蟹单价表</h2><button type="button" className="jd-home-share" aria-label="分享店铺海报" title="分享店铺海报" onClick={onShare}><AssetIcon name="qr" size={18} /></button></div>
      <p className={`jd-home-heading-note${unavailable ? ' is-unavailable' : ''}`}>单价 / 只 · 包装与运费另计，运费发货后定价</p>
    </header>

    {error ? <div className="jd-home-state" role="alert"><p>{error}</p><button type="button" onClick={onRetry}>重新加载</button></div>
      : loading ? <p className="jd-home-state" role="status">正在加载规格和单价…</p>
        : specs.length === 0 ? <p className="jd-home-state">本批次还没有可选规格，开售后再来看看。</p>
          : <table className="jd-home-prices">
            <caption className="jd-visually-hidden">当季公母蟹规格与每只单价，包装和运费另计</caption>
            <colgroup><col className="jd-home-kind-col" /><col /><col className="jd-home-money-col" /></colgroup>
            <thead><tr><th scope="col">鲜蟹</th><th scope="col">规格</th><th scope="col" className="jd-home-money">单价 / 只</th></tr></thead>
            {groups.filter(group => group.specs.length > 0).map(group => <tbody key={group.gender}>
              {group.specs.map((spec, index) => <tr key={spec.id}>
                {index === 0 && <th scope="rowgroup" rowSpan={group.specs.length} className="jd-home-kind"><div><img className="jd-home-kind-image" src={`/assets/jiangdu-v1/spec-icons/${group.gender}-crab.webp?v=${specAssetVersion}`} alt={`完整${group.label}`} /><strong>{group.label}</strong></div></th>}
                <th scope="row" className="jd-home-spec"><SpecBadge gender={group.gender} weightLabel={spec.weightLabel} compact showLabel={false} /><strong className="jd-home-spec-label">{spec.weightLabel}</strong></th>
                <td className="jd-home-money"><strong>{formatYuan(spec.priceCents)}</strong></td>
              </tr>)}
            </tbody>)}
          </table>}

    <div className="jd-home-buy">
      <p>按只计价 · 满 10 只成盒</p>
      <button type="button" className="jd-button" disabled={unavailable || specs.length === 0} onClick={() => navigate('select')}>{noBatch ? '等待开售' : cutoffPassed ? '已截单' : '自定义套装下单'}<AssetIcon name="arrow-right" size={18} /></button>
    </div>

    {template && !loading && !error && <div className="jd-home-template">
      <div><strong>{template.name}</strong><p>{template.items.map(item => <span className="jd-inline-specs" key={item.specId}><SpecBadge gender={item.gender} weightLabel={item.weightLabel} compact /> × {item.quantity}</span>)}</p>{templateError && <p>{templateError}</p>}</div>
      <button type="button" disabled={unavailable || Boolean(templateError)} onClick={() => selectTemplate(template)}><span>{formatYuan(template.crabCentsPerCopy)}<small> / 套蟹款</small></span><span>{templateError ? '暂不可选' : '选预设套装'}<AssetIcon name="arrow-right" size={14} /></span></button>
    </div>}

    {/* 养殖、吃法与公母辨别：三张完整图解直接展示，不裁切主体。 */}
    <section className="jd-home-story" aria-labelledby="jd-home-story-title">
      <h2 id="jd-home-story-title">从蟹塘到餐桌</h2>
      <div className="jd-home-story-grid">
        <figure><img src={`/assets/jiangdu-v1/guides/crab-process.webp?v=${visualAssetVersion}`} alt="大闸蟹从放苗、养殖、捕捞、冷链到餐桌的流程" loading="lazy" /><figcaption><b>从蟹苗到餐桌</b><span>放苗、养殖、捕捞、冷链、上桌</span></figcaption></figure>
        <figure><img src={`/assets/jiangdu-v1/guides/crab-eating-guide.webp?v=${visualAssetVersion}`} alt="大闸蟹开壳、去除不可食部位、拆身取肉的食用步骤" loading="lazy" /><figcaption><b>正确吃蟹</b><span>开壳、去不可食、拆身取肉</span></figcaption></figure>
        <figure><img src={`/assets/jiangdu-v1/guides/crab-specs-gender.webp?v=${visualAssetVersion}`} alt="大闸蟹公母腹面和三两至五两规格对比" loading="lazy" /><figcaption><b>公母怎么分</b><span>公蟹毛螯尖脐，母蟹细螯圆脐</span></figcaption></figure>
      </div>
    </section>
  </section>
}
