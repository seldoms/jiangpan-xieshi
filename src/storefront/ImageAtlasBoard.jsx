import { useState } from 'react'
import artwork from '../../docs/image-atlas/art-crops-v1.json'
import icons from '../../docs/image-atlas/icon-crops-v1.json'
import sourceOne from '../../docs/image-atlas/sources/1.png'
import sourceTwo from '../../docs/image-atlas/sources/2.png'
import { AssetIcon } from './ImageSlot'
import './atlas-board.css'

const iconNames = { 'arrow-right': '向右', 'arrow-left': '向左', plus: '增加', minus: '减少', bag: '购物袋', check: '确认', pin: '地址', close: '关闭', box: '包装', leaf: '叶片', truck: '配送', clock: '时间', 'chevron-down': '展开', edit: '编辑', trash: '删除', search: '搜索' }
const iconAssets = icons.assets.map(asset => ({ ...asset, name: iconNames[asset.name], src: `/${asset.path.replace(/^public\//, '')}`, width: asset.outputSize.width, height: asset.outputSize.height }))
const rejectedAssets = icons.rejected.map(asset => ({ ...asset, name: iconNames[asset.name], rejected: true }))
const sheets = [
  { id: '1', name: '风物、标志与图标', filename: '1.png', src: sourceOne, width: icons.sourceSize.width, height: icons.sourceSize.height, assets: [...artwork.filter(asset => asset.source === '1.png'), ...iconAssets, ...rejectedAssets].sort((a, b) => a.id.localeCompare(b.id)) },
  { id: '2', name: '鲜蟹与包装', filename: '2.png', src: sourceTwo, width: 1672, height: 940, assets: artwork.filter(asset => asset.source === '2.png') },
]
const percent = (value, total) => `${Number((value / total * 100).toFixed(2))}%`

function RetainedChevron() {
  return <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="保留的向下折角 SVG 图标"><path d="m5 9 7 7 7-7" /></svg>
}

export default function ImageAtlasBoard() {
  const [sheetId, setSheetId] = useState('1')
  const [assetId, setAssetId] = useState('A01')
  const [showBounds, setShowBounds] = useState(true)
  const sheet = sheets.find(item => item.id === sheetId)
  const selected = sheet.assets.find(asset => asset.id === assetId) || sheet.assets[0]
  const selectSheet = id => {
    setSheetId(id)
    setAssetId(sheets.find(item => item.id === id).assets[0].id)
  }

  return <div className="jd-storefront jd-atlas-board jd-atlas-current">
    <header className="jd-atlas-header"><a className="jd-link" href="?view=shop"><AssetIcon name="arrow-left" />返回购物排版</a><span>实际原图 · 裁切记录</span></header>
    <div className="jd-atlas-intro"><span className="jd-kicker">彩墨入画，各就各位</span><h1>两张原图，一套秋色。</h1><p>按回图的真实尺寸裁切；框线与编号仅用于验收，不会出现在购物页面。</p></div>
    <div className="jd-atlas-toolbar"><div className="jd-atlas-tabs" role="group" aria-label="素材原图选择">{sheets.map(item => <button type="button" key={item.id} aria-pressed={sheetId === item.id} className={sheetId === item.id ? 'is-selected' : ''} onClick={() => selectSheet(item.id)}>{item.id}<span>{item.name}</span></button>)}</div><label className="jd-atlas-bounds-toggle"><input type="checkbox" checked={showBounds} onChange={event => setShowBounds(event.target.checked)} />显示裁切框</label></div>
    <div className="jd-atlas-grid">
      <div className="jd-atlas-source" style={{ aspectRatio: `${sheet.width} / ${sheet.height}` }}>
        <img src={sheet.src} alt={`${sheet.filename} 原始素材拼图，${sheet.width} × ${sheet.height} 像素`} width={sheet.width} height={sheet.height} />
        {showBounds && sheet.assets.map(asset => { const rect = asset.sourceRect; return <button type="button" key={asset.id} className={`jd-atlas-crop${selected.id === asset.id ? ' is-active' : ''}${asset.rejected ? ' is-rejected' : ''}`} style={{ left: percent(rect.x, sheet.width), top: percent(rect.y, sheet.height), width: percent(rect.width, sheet.width), height: percent(rect.height, sheet.height) }} onClick={() => setAssetId(asset.id)} aria-label={`${asset.id} ${asset.name}${asset.rejected ? '，已剔除' : ''}`} aria-pressed={selected.id === asset.id}><span>{asset.id}{asset.rejected ? ' ×' : ''}</span></button> })}
      </div>
      <aside className="jd-atlas-notes">
        <span className="jd-kicker">{selected.id} · {sheet.filename}</span><h2>{selected.name}</h2>
        <div className={`jd-atlas-output-preview${selected.rejected ? ' is-fallback' : ''}`}>{selected.rejected ? <RetainedChevron /> : <img src={selected.src} alt={`${selected.name}裁切结果`} width={selected.width} height={selected.height} />}</div>
        <dl><div><dt>原图</dt><dd>{sheet.width} × {sheet.height} px</dd></div><div><dt>左上角</dt><dd>{selected.sourceRect.x}, {selected.sourceRect.y}</dd></div><div><dt>裁切范围</dt><dd>{selected.sourceRect.width} × {selected.sourceRect.height} px</dd></div><div><dt>实际输出</dt><dd>{selected.rejected ? '保留 SVG' : `${selected.width} × ${selected.height} px`}</dd></div></dl>
        <p>{selected.rejected ? selected.reason : selected.id.startsWith('C') && Number(selected.id.slice(1)) >= 4 ? '已去除纸面背景，保留抗锯齿；图标在透明画布中居中。' : '裁切位置根据实际画面校准，保留完整主体与适当留白。'}</p>
      </aside>
    </div>
    <div className="jd-atlas-table-wrap"><table className="jd-atlas-table"><caption>{sheet.filename} 实际裁切表 · 左上角为 (0, 0)，范围采用左闭右开 [x, x + 宽)</caption><thead><tr><th>素材</th><th>左上角 x, y</th><th>裁切宽 × 高</th><th>相对位置 x%, y%</th><th>输出尺寸 / 状态</th></tr></thead><tbody>{sheet.assets.map(asset => <tr key={asset.id} className={selected.id === asset.id ? 'is-active' : ''}><th><button type="button" className="jd-atlas-row-select" onClick={() => setAssetId(asset.id)} aria-pressed={selected.id === asset.id}>{asset.id} · {asset.name}</button></th><td>{asset.sourceRect.x}, {asset.sourceRect.y}</td><td>{asset.sourceRect.width} × {asset.sourceRect.height}</td><td>{percent(asset.sourceRect.x, sheet.width)}, {percent(asset.sourceRect.y, sheet.height)}</td><td>{asset.rejected ? '已剔除 · 保留 SVG' : `${asset.width} × ${asset.height}`}</td></tr>)}</tbody></table></div>
    <section className="jd-atlas-fallback-note"><RetainedChevron /><div><strong>C16 · 展开图标保留 SVG</strong><p>原图画成了右下斜箭头，含义不符。购物页面继续使用清晰的向下折角，避免误导操作。</p></div></section>
  </div>
}
